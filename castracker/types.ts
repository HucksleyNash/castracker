export type SourceType = "rss" | "youtube" | "media";
export type QualityPreset = "high-m4a" | "standard-mp3" | "compact-mp3";
export type EpisodeStatus =
  | "available"
  | "queued"
  | "downloading"
  | "downloaded"
  | "failed"
  | "unavailable";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Episode {
  id: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  season: number | null;
  episode: number | null;
  episodeType: "full" | "trailer" | "bonus";
  sourceUrl: string;
  thumbnailUrl: string | null;
  status: EpisodeStatus;
  fileName: string | null;
  fileSize: number | null;
  error: string | null;
}

export interface Podcast {
  id: string;
  sourceUrl: string;
  sourceType: SourceType;
  title: string;
  author: string;
  description: string;
  language: string;
  genres: string[];
  coverUrl: string | null;
  coverFile: string | null;
  directoryName: string;
  quality: QualityPreset;
  autoDownload: boolean;
  episodes: Episode[];
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

export interface InspectResult {
  sourceUrl: string;
  sourceType: SourceType;
  title: string;
  author: string;
  description: string;
  language: string;
  genres: string[];
  coverUrl: string | null;
  excludedEpisodeCount: number;
  episodes: Omit<Episode, "status" | "fileName" | "fileSize" | "error">[];
}

export interface DownloadFailure {
  episodeId: string;
  title: string;
  error: string;
  unavailable?: boolean;
}

export interface Job {
  id: string;
  type: "download" | "refresh" | "retag" | "tool-install";
  podcastId: string | null;
  episodeIds: string[];
  status: JobStatus;
  progress: number;
  title: string;
  message: string;
  error: string | null;
  failures?: DownloadFailure[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Settings {
  libraryPath: string;
  port: number;
}

export interface AppState {
  version: 1;
  settings: Settings;
  podcasts: Podcast[];
  jobs: Job[];
}
