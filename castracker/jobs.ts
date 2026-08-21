import { join } from "node:path";
import type { Episode, InspectResult, Job, Podcast } from "./types.ts";
import type { Store } from "./store.ts";
import type { ToolPaths } from "./media.ts";
import {
  downloadEpisode,
  retagEpisode,
  writePodcastSidecars,
} from "./media.ts";
import { inspectSource } from "./sources.ts";
import { asErrorMessage, isInaccessibleMediaError } from "./utils.ts";

export class JobQueue {
  readonly store: Store;
  readonly tools: ToolPaths;
  #pending: string[] = [];
  #running = false;

  constructor(store: Store, tools: ToolPaths) {
    this.store = store;
    this.tools = tools;
  }

  async enqueueDownload(podcastId: string, episodeIds: string[]): Promise<Job> {
    if (!this.tools.ffmpegPath) {
      throw new Error(
        "FFmpeg is required before audio can be downloaded. Install it in Settings.",
      );
    }
    const podcast = this.store.findPodcast(podcastId);
    if (!podcast) throw new Error("Podcast not found.");
    const availableIds = new Set(
      podcast.episodes.filter((episode) =>
        episode.status === "available" || episode.status === "failed"
      ).map((episode) => episode.id),
    );
    const selected = [...new Set(episodeIds)].filter((id) =>
      availableIds.has(id)
    );
    if (!selected.length) {
      throw new Error("No downloadable episodes were selected.");
    }
    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      type: "download",
      podcastId,
      episodeIds: selected,
      status: "queued",
      progress: 0,
      title: `Download ${selected.length} episode${
        selected.length === 1 ? "" : "s"
      }`,
      message: "Waiting",
      error: null,
      failures: [],
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.store.updatePodcast(podcastId, (item) => {
      for (const episode of item.episodes) {
        if (selected.includes(episode.id)) episode.status = "queued";
      }
    });
    await this.store.addJob(job);
    this.#pending.push(job.id);
    this.#kick();
    return job;
  }

  async enqueueRefresh(podcastId: string): Promise<Job> {
    const podcast = this.store.findPodcast(podcastId);
    if (!podcast) throw new Error("Podcast not found.");
    const existing = this.store.jobs.find((job) =>
      job.podcastId === podcastId && job.type === "refresh" &&
      (job.status === "queued" || job.status === "running")
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      type: "refresh",
      podcastId,
      episodeIds: [],
      status: "queued",
      progress: 0,
      title: `Refresh ${podcast.title}`,
      message: "Waiting",
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.store.addJob(job);
    this.#pending.push(job.id);
    this.#kick();
    return job;
  }

  async enqueueRetag(podcastId: string): Promise<Job> {
    if (!this.tools.ffmpegPath) {
      throw new Error(
        "FFmpeg is required to rewrite audio metadata. Install it in Settings.",
      );
    }
    const podcast = this.store.findPodcast(podcastId);
    if (!podcast) throw new Error("Podcast not found.");
    const existing = this.store.jobs.find((job) =>
      job.podcastId === podcastId && job.type === "retag" &&
      (job.status === "queued" || job.status === "running")
    );
    if (existing) return existing;
    const episodeIds = podcast.episodes.filter((episode) =>
      episode.status === "downloaded" && episode.fileName
    ).map((episode) => episode.id);
    if (!episodeIds.length) {
      throw new Error("This podcast has no downloaded episodes to retag.");
    }
    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      type: "retag",
      podcastId,
      episodeIds,
      status: "queued",
      progress: 0,
      title: `Update metadata · ${podcast.title}`,
      message: "Waiting",
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.store.addJob(job);
    this.#pending.push(job.id);
    this.#kick();
    return job;
  }

  #kick(): void {
    if (this.#running) return;
    this.#running = true;
    queueMicrotask(() => this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending.length) {
        const id = this.#pending.shift()!;
        const job = this.store.jobs.find((item) => item.id === id);
        if (!job || job.status !== "queued") continue;
        await this.#run(job);
      }
    } finally {
      this.#running = false;
      if (this.#pending.length) this.#kick();
    }
  }

  async #run(job: Job): Promise<void> {
    await this.store.updateJob(job.id, (item) => {
      item.status = "running";
      item.startedAt = new Date().toISOString();
      item.message = "Starting";
    });
    try {
      if (job.type === "download") await this.#runDownload(job);
      else if (job.type === "refresh") await this.#runRefresh(job);
      else if (job.type === "retag") await this.#runRetag(job);
      await this.store.updateJob(job.id, (item) => {
        item.status = "completed";
        item.progress = 1;
        item.message = "Complete";
        item.finishedAt = new Date().toISOString();
      });
    } catch (error) {
      await this.store.updateJob(job.id, (item) => {
        item.status = "failed";
        item.error = asErrorMessage(error);
        item.message = "Failed";
        item.finishedAt = new Date().toISOString();
      });
    }
  }

  async #runDownload(job: Job): Promise<void> {
    if (!job.podcastId) throw new Error("The download job has no podcast.");
    let failures = 0;
    for (let index = 0; index < job.episodeIds.length; index++) {
      const episodeId = job.episodeIds[index];
      let podcast = this.store.findPodcast(job.podcastId);
      if (!podcast) throw new Error("Podcast not found.");
      const episode = podcast.episodes.find((item) => item.id === episodeId);
      if (!episode) continue;
      await this.store.updatePodcast(podcast.id, (item) => {
        const target = item.episodes.find((candidate) =>
          candidate.id === episodeId
        );
        if (target) {
          target.status = "downloading";
          target.error = null;
        }
      });

      let lastProgressSave = 0;
      const updateProgress = (localProgress: number, message: string) => {
        const now = Date.now();
        if (now - lastProgressSave < 700 && localProgress < 1) return;
        lastProgressSave = now;
        const totalProgress = (index + localProgress) / job.episodeIds.length;
        this.store.updateJob(job.id, (item) => {
          item.progress = totalProgress;
          item.message = `${
            index + 1
          }/${job.episodeIds.length} · ${episode.title} · ${message}`;
        }).catch(console.error);
      };
      try {
        const result = await downloadEpisode(
          podcast,
          episode,
          this.store.settings.libraryPath,
          this.tools,
          updateProgress,
        );
        await this.store.updatePodcast(podcast.id, (item) => {
          const target = item.episodes.find((candidate) =>
            candidate.id === episodeId
          );
          if (target) {
            target.status = "downloaded";
            target.fileName = result.fileName;
            target.fileSize = result.fileSize;
            target.error = null;
          }
          if (result.coverFile) item.coverFile = result.coverFile;
        });
      } catch (error) {
        failures++;
        const message = asErrorMessage(error);
        const unavailable = podcast.sourceType !== "rss" &&
          isInaccessibleMediaError(message);
        console.error(
          `[download] ${podcast.title} / ${episode.title}: ${message}`,
        );
        await this.store.updateJob(job.id, (item) => {
          item.failures ??= [];
          item.failures.push({
            episodeId,
            title: episode.title,
            error: message,
            unavailable,
          });
        });
        await this.store.updatePodcast(podcast.id, (item) => {
          const target = item.episodes.find((candidate) =>
            candidate.id === episodeId
          );
          if (target) {
            target.status = unavailable ? "unavailable" : "failed";
            target.error = message;
          }
        });
      }
      podcast = this.store.findPodcast(job.podcastId);
      if (podcast) {
        await writePodcastSidecars(
          podcast,
          join(this.store.settings.libraryPath, podcast.directoryName),
        );
      }
    }
    if (failures) {
      throw new Error(
        `${failures} of ${job.episodeIds.length} episode downloads failed.`,
      );
    }
  }

  async #runRefresh(job: Job): Promise<void> {
    if (!job.podcastId) throw new Error("The refresh job has no podcast.");
    const podcast = this.store.findPodcast(job.podcastId);
    if (!podcast) throw new Error("Podcast not found.");
    await this.store.updateJob(job.id, (item) => {
      item.progress = 0.2;
      item.message = "Checking source";
    });
    const inspected = await inspectSource(podcast.sourceUrl, this.tools);
    const newEpisodeIds: string[] = [];
    await this.store.updatePodcast(podcast.id, (item) => {
      mergeInspection(item, inspected, newEpisodeIds);
      item.lastCheckedAt = new Date().toISOString();
    });
    await this.store.updateJob(job.id, (item) => {
      item.progress = 0.9;
      item.message = `${newEpisodeIds.length} new episode${
        newEpisodeIds.length === 1 ? "" : "s"
      }`;
    });
    const updated = this.store.findPodcast(podcast.id);
    if (updated) {
      await Deno.mkdir(
        join(this.store.settings.libraryPath, updated.directoryName),
        { recursive: true },
      );
      await writePodcastSidecars(
        updated,
        join(this.store.settings.libraryPath, updated.directoryName),
      );
    }
    if (podcast.autoDownload && newEpisodeIds.length) {
      await this.enqueueDownload(podcast.id, newEpisodeIds);
    }
  }

  async #runRetag(job: Job): Promise<void> {
    if (!job.podcastId) throw new Error("The metadata job has no podcast.");
    for (let index = 0; index < job.episodeIds.length; index++) {
      const podcast = this.store.findPodcast(job.podcastId);
      if (!podcast) throw new Error("Podcast not found.");
      const episode = podcast.episodes.find((item) =>
        item.id === job.episodeIds[index]
      );
      if (!episode) continue;
      await this.store.updateJob(job.id, (item) => {
        item.progress = index / job.episodeIds.length;
        item.message = `${
          index + 1
        }/${job.episodeIds.length} · ${episode.title}`;
      });
      await retagEpisode(
        podcast,
        episode,
        this.store.settings.libraryPath,
        this.tools,
      );
    }
    const podcast = this.store.findPodcast(job.podcastId);
    if (podcast) {
      await writePodcastSidecars(
        podcast,
        join(this.store.settings.libraryPath, podcast.directoryName),
      );
    }
  }
}

export function mergeInspection(
  podcast: Podcast,
  inspected: InspectResult,
  newIds: string[],
): void {
  const existingById = new Map(
    podcast.episodes.map((episode) => [episode.id, episode]),
  );
  const existingByUrl = new Map(
    podcast.episodes.map((episode) => [episode.sourceUrl, episode]),
  );
  const merged: Episode[] = [];
  const matchedExistingIds = new Set<string>();
  for (const candidate of inspected.episodes) {
    const existing = existingById.get(candidate.id) ??
      existingByUrl.get(candidate.sourceUrl);
    if (existing) {
      matchedExistingIds.add(existing.id);
      merged.push({
        ...existing,
        ...candidate,
        status: existing.status,
        fileName: existing.fileName,
        fileSize: existing.fileSize,
        error: existing.error,
      });
    } else {
      newIds.push(candidate.id);
      merged.push({
        ...candidate,
        status: "available",
        fileName: null,
        fileSize: null,
        error: null,
      });
    }
  }
  for (const existing of podcast.episodes) {
    if (
      !matchedExistingIds.has(existing.id) &&
      (podcast.sourceType === "rss" || existing.status === "downloaded" ||
        Boolean(existing.fileName))
    ) merged.push(existing);
  }
  podcast.episodes = merged;
  podcast.title ||= inspected.title;
  podcast.author ||= inspected.author;
  podcast.description ||= inspected.description;
  podcast.language ||= inspected.language;
  if (!podcast.genres.length) podcast.genres = inspected.genres;
  podcast.coverUrl = inspected.coverUrl || podcast.coverUrl;
}
