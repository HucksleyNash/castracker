import { basename, extname, join } from "node:path";
import type { Episode, Podcast, QualityPreset } from "./types.ts";
import {
  assertPublicRemoteUrl,
  readResponseBytes,
  safeFetch,
} from "./network.ts";
import {
  asErrorMessage,
  extensionFromUrl,
  pathExists,
  safeFilePart,
} from "./utils.ts";

export interface ToolPaths {
  ytDlpPath: string;
  denoPath: string | null;
  ffmpegPath: string | null;
  ffprobePath: string | null;
}

export interface DownloadResult {
  fileName: string;
  fileSize: number;
  coverFile: string | null;
}

interface QualitySpec {
  extension: ".m4a" | ".mp3";
  codecArgs: string[];
  label: string;
}

interface TransferProgress {
  downloaded: number;
  total: number | null;
  speed: number | null;
  etaSeconds: number | null;
}

const YT_DLP_PROGRESS_PREFIX = "__CASTRACKER_PROGRESS__";
const YT_DLP_FILE_PREFIX = "__CASTRACKER_FILE__";

export function qualitySpec(preset: QualityPreset): QualitySpec {
  switch (preset) {
    case "high-m4a":
      return {
        extension: ".m4a",
        codecArgs: ["-c:a", "aac", "-b:a", "160k"],
        label: "High · M4A 160 kbps",
      };
    case "standard-mp3":
      return {
        extension: ".mp3",
        codecArgs: ["-c:a", "libmp3lame", "-b:a", "128k"],
        label: "Standard · MP3 128 kbps",
      };
    case "compact-mp3":
      return {
        extension: ".mp3",
        codecArgs: ["-c:a", "libmp3lame", "-b:a", "64k"],
        label: "Compact · MP3 64 kbps",
      };
  }
}

function formatBytesCompact(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatEta(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = value % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

export function formatTransferProgress(
  downloaded: number,
  total: number | null,
  speed: number | null,
  etaSeconds: number | null,
): string {
  const parts = [
    "Downloading",
    total && total > 0
      ? `${formatBytesCompact(downloaded)} / ${formatBytesCompact(total)}`
      : formatBytesCompact(downloaded),
  ];
  if (speed && speed > 0) parts.push(`${formatBytesCompact(speed)}/s`);
  if (etaSeconds !== null && Number.isFinite(etaSeconds)) {
    parts.push(`ETA ${formatEta(etaSeconds)}`);
  }
  return parts.join(" · ");
}

function progressNumber(value: string | undefined): number | null {
  if (!value || value === "NA") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseYtDlpProgress(line: string): TransferProgress | null {
  const marker = line.indexOf(YT_DLP_PROGRESS_PREFIX);
  if (marker < 0) return null;
  const [downloadedValue, totalValue, estimateValue, speedValue, etaValue] =
    line
      .slice(marker + YT_DLP_PROGRESS_PREFIX.length).split("|");
  const downloaded = progressNumber(downloadedValue);
  if (downloaded === null) return null;
  return {
    downloaded,
    total: progressNumber(totalValue) ?? progressNumber(estimateValue),
    speed: progressNumber(speedValue),
    etaSeconds: progressNumber(etaValue),
  };
}

function commandError(stderr: Uint8Array, fallback: string): Error {
  const text = new TextDecoder().decode(stderr).trim();
  const useful = text.split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
  return new Error(useful || fallback);
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw commandError(
      result.stderr,
      `${basename(command)} exited with code ${result.code}.`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function readProcessLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    pending += decoder.decode();
    if (pending) onLine(pending);
  } finally {
    reader.releaseLock();
  }
}

function artworkExtension(contentType: string | null, url: string): string {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  const extension = extname(new URL(url).pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)
    ? extension
    : ".jpg";
}

export async function ensureArtwork(
  podcast: Podcast,
  directory: string,
  tools: ToolPaths,
): Promise<string | null> {
  if (
    podcast.coverFile && await pathExists(join(directory, podcast.coverFile))
  ) return podcast.coverFile;
  if (!podcast.coverUrl) return null;
  const response = await safeFetch(podcast.coverUrl, {
    headers: { "user-agent": "Castracker/0.2" },
  });
  if (!response.ok) {
    throw new Error(`Artwork request failed with HTTP ${response.status}.`);
  }
  const sourceExtension = artworkExtension(
    response.headers.get("content-type"),
    podcast.coverUrl,
  );
  const sourcePath = join(directory, `.cover-source${sourceExtension}`);
  await Deno.writeFile(
    sourcePath,
    await readResponseBytes(response, 25 * 1024 * 1024),
  );
  if (!tools.ffmpegPath) {
    const fileName = `cover${sourceExtension}`;
    await Deno.rename(sourcePath, join(directory, fileName));
    return fileName;
  }
  const coverPath = join(directory, "cover.jpg");
  try {
    await runCommand(tools.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      coverPath,
    ]);
    return "cover.jpg";
  } finally {
    await Deno.remove(sourcePath).catch(() => undefined);
  }
}

async function downloadHttp(
  url: string,
  destination: string,
  onProgress: (progress: number, message: string) => void,
): Promise<string> {
  const extension = extensionFromUrl(url, ".audio");
  const outputPath = `${destination}${extension}`;
  const partialPath = `${outputPath}.part`;
  if (await pathExists(outputPath)) {
    onProgress(1, "Using completed temporary download");
    return outputPath;
  }
  let offset = 0;
  try {
    offset = (await Deno.stat(partialPath)).size;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const headers = new Headers({ "user-agent": "Castracker/0.2" });
  if (offset > 0) headers.set("range", `bytes=${offset}-`);
  let response = await safeFetch(url, { headers });
  if (response.status === 416 && offset > 0) {
    const expected = Number(
      response.headers.get("content-range")?.match(/\*\/(\d+)$/)?.[1] ?? 0,
    );
    if (expected > 0 && expected === offset) {
      await Deno.rename(partialPath, outputPath);
      onProgress(1, "Resumed file was already complete");
      return outputPath;
    }
    await Deno.remove(partialPath).catch(() => undefined);
    offset = 0;
    headers.delete("range");
    response = await safeFetch(url, { headers });
  }
  if (!response.ok && response.status !== 206) {
    throw new Error(`Audio request failed with HTTP ${response.status}.`);
  }
  const resumed = offset > 0 && response.status === 206;
  if (!resumed) offset = 0;
  const remaining = Number(response.headers.get("content-length")) || 0;
  const total = remaining ? remaining + offset : 0;
  const file = await Deno.open(partialPath, {
    create: true,
    write: true,
    append: resumed,
    truncate: !resumed,
  });
  let downloaded = offset;
  const transferStartedAt = performance.now();
  const transferStartedBytes = offset;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The audio response had no body.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      downloaded += value.length;
      const progress = total ? Math.min(downloaded / total, 0.99) : 0.5;
      const elapsedSeconds = (performance.now() - transferStartedAt) / 1000;
      const speed = elapsedSeconds >= 0.5
        ? (downloaded - transferStartedBytes) / elapsedSeconds
        : null;
      const etaSeconds = total && speed && speed > 0
        ? Math.max(0, total - downloaded) / speed
        : null;
      onProgress(
        progress,
        formatTransferProgress(downloaded, total || null, speed, etaSeconds),
      );
    }
  } finally {
    file.close();
  }
  await Deno.rename(partialPath, outputPath);
  return outputPath;
}

async function downloadMedia(
  episode: Episode,
  temporaryBase: string,
  tools: ToolPaths,
  onProgress: (progress: number, message: string) => void,
): Promise<string> {
  await assertPublicRemoteUrl(episode.sourceUrl);
  const args = [
    "--no-playlist",
    "--continue",
    "--progress",
    "--newline",
    "--progress-delta",
    "1",
    "--progress-template",
    `download:${YT_DLP_PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
    "--no-warnings",
    "--extractor-args",
    "youtube:player_client=web_embedded,android_vr",
    "-f",
    "bestaudio[ext=m4a]/bestaudio/best",
    "-o",
    `${temporaryBase}.%(ext)s`,
    "--print",
    `after_move:${YT_DLP_FILE_PREFIX}%(filepath)s`,
  ];
  if (tools.denoPath) args.push("--js-runtimes", `deno:${tools.denoPath}`);
  args.push(episode.sourceUrl);
  onProgress(0.1, "Resolving media stream");
  const process = new Deno.Command(tools.ytDlpPath, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let path: string | null = null;
  const errors: string[] = [];
  const handleLine = (line: string, isError: boolean) => {
    const transfer = parseYtDlpProgress(line);
    if (transfer) {
      const localProgress = transfer.total && transfer.total > 0
        ? Math.min(transfer.downloaded / transfer.total, 0.99)
        : 0.5;
      onProgress(
        0.1 + localProgress * 0.6,
        formatTransferProgress(
          transfer.downloaded,
          transfer.total,
          transfer.speed,
          transfer.etaSeconds,
        ),
      );
      return;
    }
    const fileMarker = line.indexOf(YT_DLP_FILE_PREFIX);
    if (fileMarker >= 0) {
      path = line.slice(fileMarker + YT_DLP_FILE_PREFIX.length).trim();
    } else if (isError && line.trim()) {
      errors.push(line.trim());
    }
  };
  const [, , status] = await Promise.all([
    readProcessLines(process.stdout, (line) => handleLine(line, false)),
    readProcessLines(process.stderr, (line) => handleLine(line, true)),
    process.status,
  ]);
  if (!status.success) {
    throw commandError(
      new TextEncoder().encode(errors.join("\n")),
      `${basename(tools.ytDlpPath)} exited with code ${status.code}.`,
    );
  }
  if (!path || !await pathExists(path)) {
    throw new Error("The media downloader did not produce an audio file.");
  }
  onProgress(0.7, "Media downloaded");
  return path;
}

function episodeFileName(
  episode: Episode,
  podcast: Podcast,
  extension: string,
): string {
  const date = episode.publishedAt?.slice(0, 10) ?? "undated";
  const seasonEpisode = episode.season || episode.episode
    ? `${episode.season ? `S${String(episode.season).padStart(2, "0")}` : ""}${
      episode.episode ? `E${String(episode.episode).padStart(3, "0")}` : ""
    } - `
    : "";
  return `${date} - ${seasonEpisode}${
    safeFilePart(episode.title, 120)
  } [${episode.id}]${extension}`;
}

function metadataArgs(podcast: Podcast, episode: Episode): string[] {
  const values: Array<[string, string | number | null | undefined]> = [
    ["album", podcast.title],
    ["series", podcast.title],
    ["album_artist", podcast.author],
    ["artist", podcast.author],
    ["title", episode.title],
    ["comment", episode.description],
    ["description", episode.description],
    ["genre", podcast.genres.join(";") || "Podcast"],
    ["language", podcast.language],
    ["date", episode.publishedAt?.slice(0, 10)],
    ["disc", episode.season],
    ["track", episode.episode],
    ["podcast-type", "episodic"],
    ["episode-type", episode.episodeType],
  ];
  return values.flatMap(([key, value]) =>
    value === null || value === undefined || value === ""
      ? []
      : ["-metadata", `${key}=${value}`]
  );
}

async function processAudio(
  sourcePath: string,
  directory: string,
  coverFile: string | null,
  podcast: Podcast,
  episode: Episode,
  tools: ToolPaths,
): Promise<string> {
  if (!tools.ffmpegPath) {
    throw new Error(
      "FFmpeg is required to create AudioBookShelf-compatible tagged audio. Install it in Settings.",
    );
  }
  const spec = qualitySpec(podcast.quality);
  const fileName = episodeFileName(episode, podcast, spec.extension);
  const destination = join(directory, fileName);
  const processing = join(
    directory,
    `.${episode.id}.processing${spec.extension}`,
  );
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath];
  if (coverFile) args.push("-i", join(directory, coverFile));
  args.push("-map", "0:a:0");
  if (coverFile) args.push("-map", "1:v:0");
  args.push(...spec.codecArgs);
  if (coverFile) args.push("-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
  args.push(...metadataArgs(podcast, episode));
  if (podcast.language) {
    args.push("-metadata:s:a:0", `language=${podcast.language}`);
  }
  if (spec.extension === ".m4a") {
    args.push("-movflags", "+faststart");
  }
  if (spec.extension === ".mp3") args.push("-id3v2_version", "3");
  args.push(processing);
  try {
    await runCommand(tools.ffmpegPath, args);
    await Deno.rename(processing, destination);
    return destination;
  } finally {
    await Deno.remove(processing).catch(() => undefined);
  }
}

export async function writePodcastSidecars(
  podcast: Podcast,
  directory: string,
): Promise<void> {
  await Deno.writeTextFile(
    join(directory, "desc.txt"),
    `${podcast.description.trim()}\n`,
  );
  const metadata = {
    title: podcast.title,
    author: podcast.author,
    description: podcast.description,
    language: podcast.language,
    genres: podcast.genres,
    sourceUrl: podcast.sourceUrl,
    sourceType: podcast.sourceType,
    updatedAt: podcast.updatedAt,
    episodes: podcast.episodes.map((episode) => ({
      id: episode.id,
      title: episode.title,
      publishedAt: episode.publishedAt,
      season: episode.season,
      episode: episode.episode,
      fileName: episode.fileName,
      sourceUrl: episode.sourceUrl,
    })),
  };
  await Deno.writeTextFile(
    join(directory, "podcast.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export async function retagEpisode(
  podcast: Podcast,
  episode: Episode,
  libraryPath: string,
  tools: ToolPaths,
): Promise<void> {
  if (!episode.fileName) return;
  if (!tools.ffmpegPath) {
    throw new Error("FFmpeg is required to update audio metadata.");
  }
  const directory = join(libraryPath, podcast.directoryName);
  const sourcePath = join(directory, episode.fileName);
  if (!await pathExists(sourcePath)) {
    throw new Error(`Audio file is missing: ${episode.fileName}`);
  }
  const extension = extname(sourcePath).toLowerCase();
  const processing = join(directory, `.${episode.id}.retag${extension}`);
  const coverPath = podcast.coverFile
    ? join(directory, podcast.coverFile)
    : null;
  const hasCover = Boolean(coverPath && await pathExists(coverPath));
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath];
  if (hasCover && coverPath) args.push("-i", coverPath);
  args.push("-map", "0:a:0");
  args.push("-map", hasCover ? "1:v:0" : "0:v?");
  args.push("-c:a", "copy");
  if (hasCover) {
    args.push("-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
  } else {
    args.push("-c:v", "copy");
  }
  args.push(...metadataArgs(podcast, episode));
  if (podcast.language) {
    args.push("-metadata:s:a:0", `language=${podcast.language}`);
  }
  if (extension === ".m4a" || extension === ".m4b") {
    args.push("-movflags", "+faststart");
  }
  if (extension === ".mp3") args.push("-id3v2_version", "3");
  args.push(processing);
  try {
    await runCommand(tools.ffmpegPath, args);
    await Deno.rename(processing, sourcePath);
  } finally {
    await Deno.remove(processing).catch(() => undefined);
  }
}

export async function downloadEpisode(
  podcast: Podcast,
  episode: Episode,
  libraryPath: string,
  tools: ToolPaths,
  onProgress: (progress: number, message: string) => void,
): Promise<DownloadResult> {
  const directory = join(libraryPath, podcast.directoryName);
  const temporaryDirectory = join(directory, ".castracker-tmp");
  await Deno.mkdir(temporaryDirectory, { recursive: true });
  const coverFile = await ensureArtwork(podcast, directory, tools).catch(
    (error) => {
      console.warn(
        `Artwork failed for ${podcast.title}: ${asErrorMessage(error)}`,
      );
      return null;
    },
  );
  const temporaryBase = join(temporaryDirectory, episode.id);
  let sourcePath: string | null = null;
  let completed = false;
  try {
    try {
      sourcePath = podcast.sourceType === "rss"
        ? await downloadHttp(episode.sourceUrl, temporaryBase, onProgress)
        : await downloadMedia(episode, temporaryBase, tools, onProgress);
    } catch (error) {
      throw new Error(`Fetching audio failed: ${asErrorMessage(error)}`);
    }
    onProgress(0.82, "Writing metadata and artwork");
    let destination: string;
    try {
      destination = await processAudio(
        sourcePath,
        directory,
        coverFile,
        podcast,
        episode,
        tools,
      );
    } catch (error) {
      throw new Error(`Audio processing failed: ${asErrorMessage(error)}`);
    }
    const stat = await Deno.stat(destination);
    onProgress(1, "Ready in library");
    completed = true;
    return { fileName: basename(destination), fileSize: stat.size, coverFile };
  } finally {
    if (completed) {
      if (sourcePath) await Deno.remove(sourcePath).catch(() => undefined);
      try {
        for await (const item of Deno.readDir(temporaryDirectory)) {
          await Deno.remove(join(temporaryDirectory, item.name), {
            recursive: item.isDirectory,
          }).catch(() => undefined);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          console.warn(`Temporary cleanup failed: ${asErrorMessage(error)}`);
        }
      }
      await Deno.remove(temporaryDirectory).catch(() => undefined);
    }
  }
}
