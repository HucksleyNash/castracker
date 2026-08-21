import { mergeInspection } from "../jobs.ts";
import type { InspectResult, Podcast } from "../types.ts";
import { assertEquals } from "./test_helpers.ts";

Deno.test("refresh merge preserves downloads and identifies new episodes", () => {
  const now = new Date().toISOString();
  const podcast: Podcast = {
    id: "podcast",
    sourceUrl: "https://example.test/feed",
    sourceType: "rss",
    title: "Old title",
    author: "Old author",
    description: "Old description",
    language: "en",
    genres: ["Old genre"],
    coverUrl: null,
    coverFile: "cover.jpg",
    directoryName: "Podcast [podcast]",
    quality: "standard-mp3",
    autoDownload: true,
    episodes: [{
      id: "existing",
      title: "Downloaded episode",
      description: "Original",
      publishedAt: now,
      durationSeconds: 60,
      season: 1,
      episode: 1,
      episodeType: "full",
      sourceUrl: "https://example.test/existing.mp3",
      thumbnailUrl: null,
      status: "downloaded",
      fileName: "existing.mp3",
      fileSize: 1234,
      error: null,
    }],
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
  };
  const inspected: InspectResult = {
    sourceUrl: podcast.sourceUrl,
    sourceType: "rss",
    title: "Updated title",
    author: "Updated author",
    description: "Updated description",
    language: "de",
    genres: ["Education"],
    coverUrl: "https://example.test/cover.jpg",
    excludedEpisodeCount: 0,
    episodes: [
      {
        id: "new",
        title: "New episode",
        description: "New",
        publishedAt: now,
        durationSeconds: 90,
        season: 1,
        episode: 2,
        episodeType: "full",
        sourceUrl: "https://example.test/new.mp3",
        thumbnailUrl: null,
      },
      {
        id: "existing",
        title: "Downloaded episode (updated)",
        description: "Updated",
        publishedAt: now,
        durationSeconds: 61,
        season: 1,
        episode: 1,
        episodeType: "full",
        sourceUrl: "https://example.test/existing.mp3",
        thumbnailUrl: null,
      },
    ],
  };

  podcast.episodes.push({
    ...podcast.episodes[0],
    id: "archived",
    title: "No longer in feed",
    sourceUrl: "https://example.test/archived.mp3",
    status: "available",
    fileName: null,
    fileSize: null,
  });

  const newIds: string[] = [];
  mergeInspection(podcast, inspected, newIds);

  assertEquals(newIds, ["new"]);
  assertEquals(podcast.title, "Old title");
  assertEquals(podcast.author, "Old author");
  assertEquals(podcast.genres, ["Old genre"]);
  assertEquals(podcast.coverUrl, "https://example.test/cover.jpg");
  assertEquals(podcast.episodes[0].status, "available");
  assertEquals(podcast.episodes[1].status, "downloaded");
  assertEquals(podcast.episodes[1].fileName, "existing.mp3");
  assertEquals(podcast.episodes[1].fileSize, 1234);
  assertEquals(podcast.episodes[2].id, "archived");

  podcast.sourceType = "youtube";
  const mediaInspection: InspectResult = {
    ...inspected,
    sourceType: "youtube",
    episodes: [inspected.episodes[1]],
  };
  mergeInspection(podcast, mediaInspection, []);
  assertEquals(
    podcast.episodes.map((episode) => episode.id),
    ["existing"],
  );
});
