import {
  detectSourceType,
  isDownloadableMediaEntry,
  parseRss,
} from "../sources.ts";
import { assertEquals, assertThrows } from "./test_helpers.ts";

Deno.test("parseRss extracts podcast and episode metadata", () => {
  const result = parseRss(
    `<?xml version="1.0"?>
    <rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title><![CDATA[Coffee &amp; Cases]]></title>
        <itunes:author>Example Studio</itunes:author>
        <description><![CDATA[<p>A &amp; B show.</p>]]></description>
        <language>en-US</language>
        <itunes:image href="https://cdn.example.test/cover.jpg" />
        <itunes:category text="Education" />
        <item>
          <guid>episode-one</guid>
          <title><![CDATA[The <b>first</b> episode]]></title>
          <description><![CDATA[<p>Hello&nbsp;world</p>]]></description>
          <pubDate>Tue, 18 Aug 2026 10:00:00 GMT</pubDate>
          <itunes:duration>01:02:03</itunes:duration>
          <itunes:season>2</itunes:season>
          <itunes:episode>4</itunes:episode>
          <itunes:episodeType>bonus</itunes:episodeType>
          <enclosure url="https://cdn.example.test/one.mp3?token=a&amp;b=c" type="audio/mpeg" length="123" />
        </item>
        <category><![CDATA[Language Learning]]></category>
      </channel>
    </rss>`,
    "https://feeds.example.test/show.xml",
  );

  assertEquals(result.sourceType, "rss");
  assertEquals(result.title, "Coffee & Cases");
  assertEquals(result.author, "Example Studio");
  assertEquals(result.description, "A & B show.");
  assertEquals(result.genres, ["Education", "Language Learning"]);
  assertEquals(result.coverUrl, "https://cdn.example.test/cover.jpg");
  assertEquals(result.excludedEpisodeCount, 0);
  assertEquals(result.episodes.length, 1);
  assertEquals(result.episodes[0].title, "The first episode");
  assertEquals(result.episodes[0].description, "Hello world");
  assertEquals(result.episodes[0].durationSeconds, 3723);
  assertEquals(result.episodes[0].season, 2);
  assertEquals(result.episodes[0].episode, 4);
  assertEquals(result.episodes[0].episodeType, "bonus");
  assertEquals(
    result.episodes[0].sourceUrl,
    "https://cdn.example.test/one.mp3?token=a&b=c",
  );
});

Deno.test("parseRss rejects feeds without playable audio", () => {
  assertThrows(
    () =>
      parseRss(
        "<rss><channel><title>Empty</title></channel></rss>",
        "https://example.test/rss",
      ),
    /no audio enclosures/i,
  );
});

Deno.test("detectSourceType routes providers and rejects unsupported sources", () => {
  assertEquals(
    detectSourceType("https://www.youtube.com/playlist?list=abc"),
    "youtube",
  );
  assertEquals(
    detectSourceType("https://feeds.example.test/public/shows/example"),
    "rss",
  );
  assertEquals(detectSourceType("https://example.test/video/123"), "media");
  assertThrows(() => detectSourceType("spotify:show:123"), /Only HTTP/i);
  assertThrows(
    () => detectSourceType("https://open.spotify.com/show/123"),
    /not supported/i,
  );
});

Deno.test("media inspection excludes inaccessible and restricted entries", () => {
  assertEquals(
    isDownloadableMediaEntry({
      title: "Public episode",
      availability: "public",
    }),
    true,
  );
  assertEquals(isDownloadableMediaEntry({ title: "Public episode" }), true);
  for (
    const availability of [
      "private",
      "unlisted",
      "premium_only",
      "subscriber_only",
      "needs_auth",
    ]
  ) {
    assertEquals(
      isDownloadableMediaEntry({ title: "Restricted", availability }),
      false,
    );
  }
  assertEquals(isDownloadableMediaEntry({ title: "" }), false);
  assertEquals(isDownloadableMediaEntry({ title: "[Deleted video]" }), false);
  assertEquals(
    isDownloadableMediaEntry({ title: "Members-only content" }),
    false,
  );
});
