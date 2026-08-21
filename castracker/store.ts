import type { AppState, Job, Podcast, Settings } from "./types.ts";
import {
  atomicWriteJson,
  isInaccessibleMediaError,
  pathExists,
} from "./utils.ts";

export class Store {
  readonly stateDirectory: string;
  readonly statePath: string;
  #state: AppState;
  #saveChain: Promise<void> = Promise.resolve();

  private constructor(stateDirectory: string, state: AppState) {
    this.stateDirectory = stateDirectory;
    this.statePath = `${stateDirectory}/state.json`;
    this.#state = state;
  }

  static async open(
    stateDirectory: string,
    defaultLibraryPath: string,
    port: number,
  ): Promise<Store> {
    await Deno.mkdir(stateDirectory, { recursive: true });
    const statePath = `${stateDirectory}/state.json`;
    let state: AppState;
    if (await pathExists(statePath)) {
      state = JSON.parse(await Deno.readTextFile(statePath)) as AppState;
      state.jobs = state.jobs.map((job) =>
        job.status === "running" || job.status === "queued"
          ? {
            ...job,
            status: "failed",
            error: "The app stopped before this job completed.",
            finishedAt: new Date().toISOString(),
          }
          : job
      );
      state.podcasts = state.podcasts.map((podcast) => ({
        ...podcast,
        episodes: podcast.episodes.map((episode) => {
          if (
            episode.status === "queued" || episode.status === "downloading"
          ) {
            return {
              ...episode,
              status: "failed" as const,
              error:
                "The app stopped before this download completed. It can be selected and retried.",
            };
          }
          if (
            podcast.sourceType !== "rss" && episode.status === "failed" &&
            isInaccessibleMediaError(episode.error)
          ) {
            return { ...episode, status: "unavailable" as const };
          }
          return episode;
        }),
      }));
    } else {
      state = {
        version: 1,
        settings: { libraryPath: defaultLibraryPath, port },
        podcasts: [],
        jobs: [],
      };
    }
    const store = new Store(stateDirectory, state);
    await store.save();
    return store;
  }

  get state(): AppState {
    return structuredClone(this.#state);
  }

  get settings(): Settings {
    return structuredClone(this.#state.settings);
  }

  get podcasts(): Podcast[] {
    return structuredClone(this.#state.podcasts);
  }

  get jobs(): Job[] {
    return structuredClone(this.#state.jobs);
  }

  findPodcast(id: string): Podcast | undefined {
    const podcast = this.#state.podcasts.find((item) => item.id === id);
    return podcast ? structuredClone(podcast) : undefined;
  }

  async addPodcast(podcast: Podcast): Promise<void> {
    if (
      this.#state.podcasts.some((item) => item.sourceUrl === podcast.sourceUrl)
    ) {
      throw new Error("This source is already in the library.");
    }
    this.#state.podcasts.unshift(structuredClone(podcast));
    await this.save();
  }

  async updatePodcast(
    id: string,
    update: (podcast: Podcast) => void,
  ): Promise<Podcast> {
    const podcast = this.#state.podcasts.find((item) => item.id === id);
    if (!podcast) throw new Error("Podcast not found.");
    update(podcast);
    podcast.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(podcast);
  }

  async removePodcast(id: string): Promise<Podcast> {
    const index = this.#state.podcasts.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Podcast not found.");
    const [removed] = this.#state.podcasts.splice(index, 1);
    await this.save();
    return structuredClone(removed);
  }

  async setSettings(settings: Partial<Settings>): Promise<void> {
    this.#state.settings = { ...this.#state.settings, ...settings };
    await this.save();
  }

  async addJob(job: Job): Promise<void> {
    this.#state.jobs.unshift(structuredClone(job));
    this.#state.jobs = this.#state.jobs.slice(0, 200);
    await this.save();
  }

  async updateJob(id: string, update: (job: Job) => void): Promise<Job> {
    const job = this.#state.jobs.find((item) => item.id === id);
    if (!job) throw new Error("Job not found.");
    update(job);
    await this.save();
    return structuredClone(job);
  }

  async save(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    this.#saveChain = this.#saveChain.then(() =>
      atomicWriteJson(this.statePath, snapshot)
    );
    await this.#saveChain;
  }
}
