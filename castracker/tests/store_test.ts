import { join } from "node:path";
import type { Podcast } from "../types.ts";
import { Store } from "../store.ts";
import { assertEquals, assertThrows } from "./test_helpers.ts";

function samplePodcast(id = "show-1"): Podcast {
  const now = new Date().toISOString();
  return {
    id,
    sourceUrl: `https://feeds.example.test/${id}.rss`,
    sourceType: "rss",
    title: "Sample show",
    author: "Example",
    description: "A test podcast",
    language: "en",
    genres: ["Education"],
    coverUrl: null,
    coverFile: null,
    directoryName: `Sample show [${id}]`,
    quality: "high-m4a",
    autoDownload: false,
    episodes: [],
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
  };
}

Deno.test("Store persists podcasts and settings without exposing mutable state", async () => {
  const root = await Deno.makeTempDir({ prefix: "castracker-store-" });
  try {
    const stateDirectory = join(root, "state");
    const library = join(root, "library");
    const store = await Store.open(stateDirectory, library, 8787);
    await store.addPodcast(samplePodcast());
    await store.updatePodcast("show-1", (podcast) => {
      podcast.title = "Changed";
      podcast.episodes.push({
        id: "queued-episode",
        title: "Interrupted",
        description: "",
        publishedAt: null,
        durationSeconds: null,
        season: null,
        episode: null,
        episodeType: "full",
        sourceUrl: "https://example.test/audio.mp3",
        thumbnailUrl: null,
        status: "queued",
        fileName: null,
        fileSize: null,
        error: null,
      });
      podcast.episodes.push({
        id: "private-episode",
        title: "Private",
        description: "",
        publishedAt: null,
        durationSeconds: null,
        season: null,
        episode: null,
        episodeType: "full",
        sourceUrl: "https://example.test/private",
        thumbnailUrl: null,
        status: "failed",
        fileName: null,
        fileSize: null,
        error: "Video unavailable. This video has been removed by the uploader",
      });
      podcast.sourceType = "youtube";
    });
    await store.setSettings({ port: 9999 });

    const snapshot = store.state;
    snapshot.podcasts[0].title = "Mutated outside";
    assertEquals(store.findPodcast("show-1")?.title, "Changed");

    const reopened = await Store.open(stateDirectory, library, 8787);
    assertEquals(reopened.findPodcast("show-1")?.title, "Changed");
    assertEquals(reopened.findPodcast("show-1")?.episodes[0].status, "failed");
    assertEquals(
      reopened.findPodcast("show-1")?.episodes[1].status,
      "unavailable",
    );
    assertEquals(reopened.settings.port, 9999);
    assertThrows(() => {
      throw new Error("placeholder");
    }, /placeholder/);
    let duplicateError = "";
    try {
      await reopened.addPodcast(samplePodcast("show-1"));
    } catch (error) {
      duplicateError = String(error);
    }
    if (!/already in the library/i.test(duplicateError)) {
      throw new Error("Duplicate sources were not rejected.");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
