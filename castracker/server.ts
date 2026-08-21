import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppState,
  InspectResult,
  Job,
  Podcast,
  QualityPreset,
} from "./types.ts";
import { Store } from "./store.ts";
import { inspectSource } from "./sources.ts";
import {
  ensureArtwork,
  type ToolPaths,
  writePodcastSidecars,
} from "./media.ts";
import { JobQueue } from "./jobs.ts";
import { asErrorMessage, pathExists, safeFilePart, stableId } from "./utils.ts";

const APP_NAME = "Castracker";
const APP_VERSION = "0.2.0";
const appDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(appDirectory, "..");
const publicDirectory = join(appDirectory, "public");
const stateDirectory = join(projectRoot, ".castracker");
const legacyStateDirectory = join(projectRoot, ".podcast-manager");
const defaultLibraryPath = join(projectRoot, "castracker-library");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

function findOnPath(names: string[]): string | null {
  const paths = (Deno.env.get("PATH") ?? "").split(
    Deno.build.os === "windows" ? ";" : ":",
  );
  for (const directory of paths) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (Deno.statSync(candidate).isFile) return candidate;
      } catch { /* Keep looking. */ }
    }
  }
  return null;
}

function existingFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function discoverTools(): ToolPaths {
  const localYtDlp = join(
    projectRoot,
    ".tools",
    Deno.build.os === "windows" ? "yt-dlp.exe" : "yt-dlp",
  );
  const localDeno = join(
    projectRoot,
    ".tools",
    Deno.build.os === "windows" ? "deno.exe" : "deno",
  );
  const localFfmpeg = join(
    projectRoot,
    ".tools",
    "ffmpeg",
    "bin",
    Deno.build.os === "windows" ? "ffmpeg.exe" : "ffmpeg",
  );
  const localFfprobe = join(
    projectRoot,
    ".tools",
    "ffmpeg",
    "bin",
    Deno.build.os === "windows" ? "ffprobe.exe" : "ffprobe",
  );
  return {
    ytDlpPath: existingFile(localYtDlp)
      ? localYtDlp
      : (findOnPath(["yt-dlp.exe", "yt-dlp"]) ?? localYtDlp),
    denoPath: existingFile(localDeno)
      ? localDeno
      : findOnPath(["deno.exe", "deno"]),
    ffmpegPath: existingFile(localFfmpeg)
      ? localFfmpeg
      : findOnPath(["ffmpeg.exe", "ffmpeg"]),
    ffprobePath: existingFile(localFfprobe)
      ? localFfprobe
      : findOnPath(["ffprobe.exe", "ffprobe"]),
  };
}

interface AppContext {
  store: Store;
  queue: JobQueue;
  tools: ToolPaths;
  inspections: Map<string, { value: InspectResult; expiresAt: number }>;
  library: LibraryStatus;
}

interface LibraryStatus {
  path: string;
  available: boolean;
  error: string | null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: unknown, status = 400): Response {
  return json({ error: asErrorMessage(error) }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2_000_000) throw new Error("Request body is too large.");
  try {
    return await request.json();
  } catch {
    throw new Error("The request body must be valid JSON.");
  }
}

function requestedUrl(body: Record<string, unknown>): string {
  if (body.rightsAcknowledged !== true) {
    throw new Error(
      "Confirm that you have the right or permission to access and download this source.",
    );
  }
  if (typeof body.url !== "string" || !body.url.trim()) {
    throw new Error("A source URL is required.");
  }
  return body.url.trim();
}

function validQuality(value: unknown): QualityPreset {
  if (
    value === "high-m4a" || value === "standard-mp3" || value === "compact-mp3"
  ) return value;
  return "high-m4a";
}

function podcastSummary(podcast: Podcast) {
  const downloaded =
    podcast.episodes.filter((episode) => episode.status === "downloaded")
      .length;
  const failed =
    podcast.episodes.filter((episode) => episode.status === "failed").length;
  const bytes = podcast.episodes.reduce(
    (sum, episode) => sum + (episode.fileSize ?? 0),
    0,
  );
  return {
    ...podcast,
    downloadedCount: downloaded,
    failedCount: failed,
    libraryBytes: bytes,
  };
}

function toolsStatus(tools: ToolPaths) {
  return {
    ytDlp: {
      available: Boolean(tools.ytDlpPath && existingFile(tools.ytDlpPath)),
    },
    deno: { available: Boolean(tools.denoPath) },
    ffmpeg: { available: Boolean(tools.ffmpegPath) },
    ffprobe: { available: Boolean(tools.ffprobePath) },
  };
}

interface LaunchOptions {
  port: number;
}

function validPort(value: string | number): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port '${value}'. Use a number from 1 to 65535.`);
  }
  return port;
}

export function parseLaunchOptions(
  args: string[],
  defaults: LaunchOptions = { port: 8787 },
): LaunchOptions {
  let port = validPort(defaults.port);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--port" || argument === "-p") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a port number.`);
      port = validPort(value);
    } else if (argument.startsWith("--port=")) {
      port = validPort(argument.slice("--port=".length));
    } else if (argument === "--host" || argument.startsWith("--host=")) {
      throw new Error(
        "Castracker is local-only; binding to a different host is not supported.",
      );
    } else if (argument !== "--help" && argument !== "-h") {
      throw new Error(`Unknown option '${argument}'. Use --help for usage.`);
    }
  }
  return { port };
}

async function inspectCached(
  context: AppContext,
  url: string,
): Promise<InspectResult> {
  const cached = context.inspections.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return structuredClone(cached.value);
  }
  const result = await inspectSource(url, context.tools);
  context.inspections.set(url, {
    value: structuredClone(result),
    expiresAt: Date.now() + 10 * 60_000,
  });
  return result;
}

async function addPodcast(
  context: AppContext,
  body: Record<string, unknown>,
): Promise<{ podcast: Podcast; job: Job | null }> {
  const sourceUrl = requestedUrl(body);
  if (
    context.store.podcasts.some((podcast) => podcast.sourceUrl === sourceUrl)
  ) {
    throw new Error("This source is already in the library.");
  }
  const inspected = await inspectCached(context, sourceUrl);
  const id = `${stableId(sourceUrl)}-${Date.now().toString(36).slice(-4)}`;
  const now = new Date().toISOString();
  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim()
    : inspected.title;
  const selectedIds = Array.isArray(body.episodeIds)
    ? body.episodeIds.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  if (selectedIds.length && !context.tools.ffmpegPath) {
    throw new Error(
      "FFmpeg is required for the initial download. Install it in Settings, then select episodes from the podcast page.",
    );
  }
  const podcast: Podcast = {
    id,
    sourceUrl,
    sourceType: inspected.sourceType,
    title,
    author: typeof body.author === "string"
      ? body.author.trim()
      : inspected.author,
    description: typeof body.description === "string"
      ? body.description.trim()
      : inspected.description,
    language: typeof body.language === "string"
      ? body.language.trim()
      : inspected.language,
    genres: Array.isArray(body.genres)
      ? body.genres.filter((value): value is string =>
        typeof value === "string"
      )
      : inspected.genres,
    coverUrl: inspected.coverUrl,
    coverFile: null,
    directoryName: `${safeFilePart(title, 100)} [${id}]`,
    quality: validQuality(body.quality),
    autoDownload: body.autoDownload === true,
    episodes: inspected.episodes.map((episode) => ({
      ...episode,
      status: "available",
      fileName: null,
      fileSize: null,
      error: null,
    })),
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
  };
  const directory = join(
    context.store.settings.libraryPath,
    podcast.directoryName,
  );
  await Deno.mkdir(directory, { recursive: true });
  await context.store.addPodcast(podcast);
  const coverFile = await ensureArtwork(podcast, directory, context.tools)
    .catch(() => null);
  if (coverFile) {
    await context.store.updatePodcast(id, (item) => {
      item.coverFile = coverFile;
    });
  }
  const stored = context.store.findPodcast(id)!;
  await writePodcastSidecars(stored, directory);
  const job = selectedIds.length
    ? await context.queue.enqueueDownload(id, selectedIds)
    : null;
  return { podcast: context.store.findPodcast(id)!, job };
}

function isInside(parent: string, child: string): boolean {
  const difference = relative(resolve(parent), resolve(child));
  return difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference));
}

export function normalizeLibraryPathInput(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("A library path is required.");

  const windowsPath = input.replaceAll("/", "\\");
  if (windowsPath.startsWith("\\\\")) {
    const parts = windowsPath.slice(2).split("\\").filter(Boolean);
    if (
      parts.length < 2 || parts[0].includes(":") || parts[1].includes(":")
    ) {
      throw new Error(
        "Invalid network path. Use \\\\server\\share\\folder with no colon after the server name; for example, \\\\192.168.0.140\\media\\podcasts.",
      );
    }
  }

  return resolve(input);
}

function libraryAccessError(path: string, error: unknown): Error {
  return new Error(
    `Castracker cannot use '${path}'. Confirm the folder or mounted network share exists and that your account has read and write access. ${
      asErrorMessage(error)
    }`,
  );
}

async function inspectLibrary(path: string): Promise<LibraryStatus> {
  try {
    await Deno.mkdir(path, { recursive: true });
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      throw new Error("The selected path is not a folder.");
    }
    return { path, available: true, error: null };
  } catch (error) {
    const message = libraryAccessError(path, error).message;
    return { path, available: false, error: message };
  }
}

async function assertLibraryWritable(path: string): Promise<void> {
  const probe = join(path, `.castracker-write-test-${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    await Deno.mkdir(path, { recursive: true });
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      throw new Error("The selected path is not a folder.");
    }
    await Deno.writeTextFile(probe, "Castracker access check\n", {
      createNew: true,
    });
    created = true;
  } catch (error) {
    throw libraryAccessError(path, error);
  } finally {
    if (created) await Deno.remove(probe).catch(() => undefined);
  }
}

async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyDirectory(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`Cannot migrate symbolic link: ${from}`);
  }
}

async function moveDirectory(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await Deno.rename(source, destination);
  } catch (error) {
    const isCrossDevice = error instanceof Deno.errors.NotSupported ||
      /cross-device|different (?:disk|device)|os error 17/i.test(
        asErrorMessage(error),
      );
    if (!isCrossDevice) throw error;
    try {
      await copyDirectory(source, destination);
      await Deno.remove(source, { recursive: true });
    } catch (copyError) {
      await Deno.remove(destination, { recursive: true }).catch(() =>
        undefined
      );
      throw copyError;
    }
  }
}

async function migrateLibrary(
  context: AppContext,
  libraryPath: string,
): Promise<void> {
  const previousPath = resolve(context.store.settings.libraryPath);
  const nextPath = resolve(libraryPath);
  const activeJob = context.store.jobs.find((job) =>
    job.status === "queued" || job.status === "running"
  );
  if (activeJob) {
    throw new Error(
      "Wait for active jobs to finish before changing the library folder.",
    );
  }

  await assertLibraryWritable(nextPath);
  if (previousPath.toLowerCase() === nextPath.toLowerCase()) return;

  const directories = context.store.podcasts.map((podcast) => ({
    source: join(previousPath, podcast.directoryName),
    destination: join(nextPath, podcast.directoryName),
  }));
  for (const directory of directories) {
    if (isInside(directory.source, nextPath)) {
      throw new Error(
        "The library folder cannot be placed inside a managed podcast folder.",
      );
    }
    if (
      await pathExists(directory.source) &&
      await pathExists(directory.destination)
    ) {
      throw new Error(
        `The destination already contains '${directory.destination}'.`,
      );
    }
  }

  const moved: typeof directories = [];
  try {
    for (const directory of directories) {
      if (!await pathExists(directory.source)) continue;
      await moveDirectory(directory.source, directory.destination);
      moved.push(directory);
    }
  } catch (error) {
    for (const directory of moved.reverse()) {
      await moveDirectory(directory.destination, directory.source).catch(
        console.error,
      );
    }
    throw error;
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/"
    ? "index.html"
    : pathname.replace(/^\/+/, "");
  const path = resolve(publicDirectory, relativePath);
  if (!isInside(publicDirectory, path)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const file = await Deno.readFile(path);
    return new Response(file, {
      headers: {
        "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ??
          "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

async function serveAudio(request: Request, path: string): Promise<Response> {
  const stat = await Deno.stat(path);
  const range = request.headers.get("range");
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ??
    "application/octet-stream";
  if (!range) {
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: {
        "content-type": type,
        "content-length": String(stat.size),
        "accept-ranges": "bytes",
      },
    });
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${stat.size}` },
    });
  }
  const isSuffixRange = !match[1] && Boolean(match[2]);
  const start = isSuffixRange
    ? Math.max(0, stat.size - Number(match[2]))
    : match[1]
    ? Number(match[1])
    : 0;
  const end = isSuffixRange
    ? stat.size - 1
    : match[2]
    ? Math.min(Number(match[2]), stat.size - 1)
    : stat.size - 1;
  if (start > end || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${stat.size}` },
    });
  }
  const file = await Deno.open(path, { read: true });
  await file.seek(start, Deno.SeekMode.Start);
  let remaining = end - start + 1;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = new Uint8Array(Math.min(64 * 1024, remaining));
      const read = await file.read(buffer);
      if (read === null || remaining <= 0) {
        file.close();
        controller.close();
        return;
      }
      remaining -= read;
      controller.enqueue(buffer.subarray(0, read));
      if (remaining <= 0) {
        file.close();
        controller.close();
      }
    },
    cancel() {
      try {
        file.close();
      } catch { /* Already closed. */ }
    },
  });
  return new Response(stream, {
    status: 206,
    headers: {
      "content-type": type,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
    },
  });
}

async function installFfmpeg(context: AppContext): Promise<Job> {
  if (Deno.build.os !== "windows") {
    throw new Error(
      "Automatic FFmpeg installation is available on Windows only. Install ffmpeg with your system package manager, then restart Castracker.",
    );
  }
  const active = context.store.jobs.find((job) =>
    job.type === "tool-install" &&
    (job.status === "queued" || job.status === "running")
  );
  if (active) return active;
  const now = new Date().toISOString();
  const job: Job = {
    id: crypto.randomUUID(),
    type: "tool-install",
    podcastId: null,
    episodeIds: [],
    status: "queued",
    progress: 0,
    title: "Install FFmpeg",
    message: "Waiting",
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  await context.store.addJob(job);
  (async () => {
    await context.store.updateJob(job.id, (item) => {
      item.status = "running";
      item.startedAt = new Date().toISOString();
      item.progress = 0.1;
      item.message = "Downloading and verifying FFmpeg";
    });
    try {
      const script = join(projectRoot, "install-ffmpeg.ps1");
      const output = await new Deno.Command("powershell", {
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!output.success) {
        throw new Error(
          new TextDecoder().decode(output.stderr).trim() ||
            "FFmpeg installation failed.",
        );
      }
      const refreshed = discoverTools();
      context.tools.ffmpegPath = refreshed.ffmpegPath;
      context.tools.ffprobePath = refreshed.ffprobePath;
      if (!context.tools.ffmpegPath) {
        throw new Error("FFmpeg installed but could not be located.");
      }
      await context.store.updateJob(job.id, (item) => {
        item.status = "completed";
        item.progress = 1;
        item.message = "FFmpeg ready";
        item.finishedAt = new Date().toISOString();
      });
    } catch (error) {
      await context.store.updateJob(job.id, (item) => {
        item.status = "failed";
        item.error = asErrorMessage(error);
        item.message = "Installation failed";
        item.finishedAt = new Date().toISOString();
      });
    }
  })();
  return job;
}

function createRequestDispatcher(
  context: AppContext,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/status" && request.method === "GET") {
        const state = context.store.state;
        const episodes = state.podcasts.flatMap((podcast) => podcast.episodes);
        return json({
          name: APP_NAME,
          version: APP_VERSION,
          platform: Deno.build.os,
          capabilities: {
            automaticFfmpegInstall: Deno.build.os === "windows",
          },
          settings: state.settings,
          library: context.library,
          tools: toolsStatus(context.tools),
          stats: {
            podcasts: state.podcasts.length,
            episodes: episodes.length,
            downloaded: episodes.filter((episode) =>
              episode.status === "downloaded"
            ).length,
            bytes: episodes.reduce(
              (sum, episode) => sum + (episode.fileSize ?? 0),
              0,
            ),
          },
        });
      }
      if (path === "/api/inspect" && request.method === "POST") {
        const body = await readJson(request);
        return json(await inspectCached(context, requestedUrl(body)));
      }
      if (path === "/api/podcasts" && request.method === "GET") {
        return json(context.store.podcasts.map(podcastSummary));
      }
      if (path === "/api/podcasts" && request.method === "POST") {
        return json(await addPodcast(context, await readJson(request)), 201);
      }
      if (path === "/api/jobs" && request.method === "GET") {
        return json(context.store.jobs.slice(0, 50));
      }
      if (path === "/api/settings" && request.method === "PATCH") {
        const body = await readJson(request);
        if (typeof body.libraryPath !== "string" || !body.libraryPath.trim()) {
          throw new Error("A library path is required.");
        }
        const libraryPath = normalizeLibraryPathInput(body.libraryPath);
        await migrateLibrary(context, libraryPath);
        await context.store.setSettings({ libraryPath });
        context.library = { path: libraryPath, available: true, error: null };
        return json(context.store.settings);
      }
      if (path === "/api/tools/ffmpeg/install" && request.method === "POST") {
        return json(await installFfmpeg(context), 202);
      }

      const podcastMatch = path.match(/^\/api\/podcasts\/([^/]+)$/);
      if (podcastMatch) {
        const id = decodeURIComponent(podcastMatch[1]);
        const podcast = context.store.findPodcast(id);
        if (!podcast) return errorResponse("Podcast not found.", 404);
        if (request.method === "GET") return json(podcastSummary(podcast));
        if (request.method === "PATCH") {
          const body = await readJson(request);
          const updated = await context.store.updatePodcast(id, (item) => {
            if (typeof body.title === "string" && body.title.trim()) {
              item.title = body.title.trim();
            }
            if (typeof body.author === "string") {
              item.author = body.author.trim();
            }
            if (typeof body.description === "string") {
              item.description = body.description.trim();
            }
            if (typeof body.language === "string") {
              item.language = body.language.trim();
            }
            if (Array.isArray(body.genres)) {
              item.genres = body.genres.filter((value): value is string =>
                typeof value === "string"
              );
            }
            if (body.quality !== undefined) {
              item.quality = validQuality(body.quality);
            }
            if (typeof body.autoDownload === "boolean") {
              item.autoDownload = body.autoDownload;
            }
          });
          await writePodcastSidecars(
            updated,
            join(context.store.settings.libraryPath, updated.directoryName),
          );
          return json(podcastSummary(updated));
        }
        if (request.method === "DELETE") {
          const removeFiles = url.searchParams.get("removeFiles") === "true";
          const activeJob = context.store.jobs.find((job) =>
            job.podcastId === id &&
            (job.status === "queued" || job.status === "running")
          );
          if (activeJob) {
            throw new Error(
              "Wait for this podcast's active jobs to finish before removing it.",
            );
          }
          const directory = join(
            context.store.settings.libraryPath,
            podcast.directoryName,
          );
          if (
            removeFiles &&
            isInside(context.store.settings.libraryPath, directory)
          ) {
            await Deno.remove(directory, { recursive: true }).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            });
          }
          await context.store.removePodcast(id);
          return json({ removed: true, filesRemoved: removeFiles });
        }
      }

      const actionMatch = path.match(
        /^\/api\/podcasts\/([^/]+)\/(download|refresh|retag)$/,
      );
      if (actionMatch && request.method === "POST") {
        const id = decodeURIComponent(actionMatch[1]);
        if (!context.store.findPodcast(id)) {
          return errorResponse("Podcast not found.", 404);
        }
        if (actionMatch[2] === "refresh") {
          return json(await context.queue.enqueueRefresh(id), 202);
        }
        if (actionMatch[2] === "retag") {
          return json(await context.queue.enqueueRetag(id), 202);
        }
        const body = await readJson(request);
        const episodeIds = Array.isArray(body.episodeIds)
          ? body.episodeIds.filter((value): value is string =>
            typeof value === "string"
          )
          : [];
        return json(await context.queue.enqueueDownload(id, episodeIds), 202);
      }

      const artworkMatch = path.match(/^\/api\/podcasts\/([^/]+)\/artwork$/);
      if (
        artworkMatch && (request.method === "GET" || request.method === "HEAD")
      ) {
        const podcast = context.store.findPodcast(
          decodeURIComponent(artworkMatch[1]),
        );
        if (!podcast?.coverFile) return new Response(null, { status: 404 });
        const imagePath = join(
          context.store.settings.libraryPath,
          podcast.directoryName,
          podcast.coverFile,
        );
        if (!await pathExists(imagePath)) {
          return new Response(null, { status: 404 });
        }
        return new Response(
          request.method === "HEAD" ? null : await Deno.readFile(imagePath),
          {
            headers: {
              "content-type": CONTENT_TYPES[extname(imagePath).toLowerCase()] ??
                "image/jpeg",
            },
          },
        );
      }

      const audioMatch = path.match(
        /^\/api\/podcasts\/([^/]+)\/episodes\/([^/]+)\/audio$/,
      );
      if (
        audioMatch && (request.method === "GET" || request.method === "HEAD")
      ) {
        const podcast = context.store.findPodcast(
          decodeURIComponent(audioMatch[1]),
        );
        const episode = podcast?.episodes.find((item) =>
          item.id === decodeURIComponent(audioMatch[2])
        );
        if (!podcast || !episode?.fileName) {
          return new Response(null, { status: 404 });
        }
        const audioPath = join(
          context.store.settings.libraryPath,
          podcast.directoryName,
          episode.fileName,
        );
        if (!await pathExists(audioPath)) {
          return new Response(null, { status: 404 });
        }
        if (request.method === "HEAD") {
          const stat = await Deno.stat(audioPath);
          return new Response(null, {
            headers: {
              "content-type": CONTENT_TYPES[extname(audioPath).toLowerCase()] ??
                "application/octet-stream",
              "content-length": String(stat.size),
              "accept-ranges": "bytes",
            },
          });
        }
        return serveAudio(request, audioPath);
      }

      if (path.startsWith("/api/")) {
        return errorResponse("API route not found.", 404);
      }
      return await serveStatic(path);
    } catch (error) {
      console.error(error);
      return errorResponse(error, 400);
    }
  };
}

function securedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function localRequestViolation(
  request: Request,
): { error: string; status: number } | null {
  const url = new URL(request.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1"
  ) {
    return { error: "Castracker accepts local requests only.", status: 421 };
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) {
        return { error: "Cross-origin requests are not allowed.", status: 403 };
      }
    } catch {
      return { error: "The request origin is invalid.", status: 403 };
    }
  }
  return null;
}

export function createHandler(
  context: AppContext,
): (request: Request) => Promise<Response> {
  const dispatch = createRequestDispatcher(context);
  return async (request: Request) => {
    const violation = localRequestViolation(request);
    return securedResponse(
      violation
        ? errorResponse(violation.error, violation.status)
        : await dispatch(request),
    );
  };
}

export async function createApp(
  port = Number(Deno.env.get("CASTRACKER_PORT") ?? 8787),
): Promise<{ context: AppContext; handler: ReturnType<typeof createHandler> }> {
  if (
    !await pathExists(stateDirectory) &&
    await pathExists(legacyStateDirectory)
  ) {
    await Deno.rename(legacyStateDirectory, stateDirectory);
    console.log("Migrated legacy application state to .castracker.");
  }
  const store = await Store.open(stateDirectory, defaultLibraryPath, port);
  const library = await inspectLibrary(store.settings.libraryPath);
  if (!library.available) console.warn(library.error);
  const tools = discoverTools();
  if (!await pathExists(tools.ytDlpPath)) {
    console.warn(
      "yt-dlp is not installed; RSS feeds will still inspect, but media sources will not.",
    );
  }
  const context: AppContext = {
    store,
    tools,
    queue: undefined as unknown as JobQueue,
    inspections: new Map(),
    library,
  };
  context.queue = new JobQueue(store, tools);
  return { context, handler: createHandler(context) };
}

if (import.meta.main) {
  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(`Castracker

Usage:
  deno task start [--port <1-65535>]

Options:
  -p, --port  Listening port (default: 8787)
  -h, --help  Show this help`);
    Deno.exit(0);
  }
  const { port } = parseLaunchOptions(Deno.args, {
    port: validPort(Deno.env.get("CASTRACKER_PORT") ?? 8787),
  });
  const hostname = "127.0.0.1";
  const { handler } = await createApp(port);
  console.log(`${APP_NAME} ${APP_VERSION}`);
  console.log(`Library manager: http://${hostname}:${port}`);
  try {
    const server = Deno.serve({ hostname, port }, handler);
    await server.finished;
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(
        `${APP_NAME} could not start because ${hostname}:${port} is already in use. If Castracker is already open, use the existing window or stop it with Ctrl+C before restarting.`,
      );
      Deno.exit(1);
    }
    throw error;
  }
}
