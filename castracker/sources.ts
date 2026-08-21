import type { InspectResult, SourceType } from "./types.ts";
import {
  assertPublicRemoteUrl,
  readResponseText,
  safeFetch,
} from "./network.ts";
import {
  decodeXml,
  htmlToText,
  normalizeDate,
  parseDuration,
  stableId,
} from "./utils.ts";

interface SourceTools {
  ytDlpPath: string;
  denoPath: string | null;
}

function firstTag(block: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(":", "\\:");
    const match = block.match(
      new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"),
    );
    if (match) return decodeXml(match[1]).trim();
  }
  return "";
}

function attribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
  );
  return match ? decodeXml(match[2]).trim() : "";
}

function numberOrNull(value: string): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function parseRss(xml: string, sourceUrl: string): InspectResult {
  const channelMatch = xml.match(/<channel\b[^>]*>([\s\S]*)<\/channel>/i);
  if (!channelMatch) {
    throw new Error("The URL did not return a supported RSS podcast feed.");
  }
  const channel = channelMatch[1];
  const metadata = channel.replace(/<item\b[^>]*>[\s\S]*?<\/item>/gi, "");
  const title = htmlToText(firstTag(metadata, ["title"])) || "Untitled podcast";
  const author = firstTag(metadata, [
    "itunes:author",
    "author",
    "managingEditor",
  ]);
  const description = htmlToText(
    firstTag(metadata, ["description", "itunes:summary", "subtitle"]),
  );
  const language = firstTag(metadata, ["language"]) || "";
  const iTunesCategories = [
    ...metadata.matchAll(
      /<itunes:category\b[^>]*\btext\s*=\s*(["'])(.*?)\1[^>]*>/gi,
    ),
  ]
    .map((match) => decodeXml(match[2]).trim())
    .filter(Boolean);
  const standardCategories = [
    ...metadata.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi),
  ].map((match) => htmlToText(match[1])).filter(Boolean);
  const categories = [...new Set([...iTunesCategories, ...standardCategories])];
  const imageTag = metadata.match(/<itunes:image\b[^>]*>/i)?.[0] ?? "";
  const imageBlock = firstTag(metadata, ["image"]);
  const coverUrl = attribute(imageTag, "href") ||
    firstTag(imageBlock, ["url"]) || null;
  const episodes = [...channel.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
    .flatMap((match) => {
      const item = match[1];
      const enclosureTag = item.match(/<enclosure\b[^>]*>/i)?.[0] ?? "";
      const mediaTag = item.match(/<media:content\b[^>]*>/i)?.[0] ?? "";
      const url = attribute(enclosureTag, "url") || attribute(mediaTag, "url");
      const mimeType = attribute(enclosureTag, "type") ||
        attribute(mediaTag, "type");
      if (!url || (mimeType && !mimeType.toLowerCase().startsWith("audio/"))) {
        return [];
      }
      const episodeTitle =
        htmlToText(firstTag(item, ["title", "itunes:title"])) ||
        "Untitled episode";
      const guid = firstTag(item, ["guid", "id"]) || url;
      const type = firstTag(item, ["itunes:episodeType"]).toLowerCase();
      const episodeType: "full" | "trailer" | "bonus" =
        type === "trailer" || type === "bonus" ? type : "full";
      return [{
        id: stableId(guid),
        title: episodeTitle,
        description: htmlToText(
          firstTag(item, ["description", "itunes:summary", "content:encoded"]),
        ),
        publishedAt: normalizeDate(
          firstTag(item, ["pubDate", "published", "updated"]),
        ),
        durationSeconds: parseDuration(firstTag(item, ["itunes:duration"])),
        season: numberOrNull(firstTag(item, ["itunes:season"])),
        episode: numberOrNull(firstTag(item, ["itunes:episode"])),
        episodeType,
        sourceUrl: url,
        thumbnailUrl:
          attribute(item.match(/<itunes:image\b[^>]*>/i)?.[0] ?? "", "href") ||
          coverUrl,
      }];
    });
  if (!episodes.length) {
    throw new Error("The RSS feed contains no audio enclosures.");
  }
  return {
    sourceUrl,
    sourceType: "rss",
    title,
    author,
    description,
    language,
    genres: categories,
    coverUrl,
    excludedEpisodeCount: 0,
    episodes,
  };
}

export function detectSourceType(url: string): SourceType {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS source links are supported.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "spotify.com" || host.endsWith(".spotify.com")) {
    throw new Error("Spotify sources are not supported.");
  }
  if (
    host === "youtube.com" || host.endsWith(".youtube.com") ||
    host === "youtu.be"
  ) return "youtube";
  if (
    host.startsWith("feeds.") ||
    /(^|\/)(feed|feeds|rss)(\/|$)/i.test(parsed.pathname) ||
    /\.(xml|rss)$/i.test(parsed.pathname)
  ) {
    return "rss";
  }
  return "media";
}

function imageFromYtDlp(value: Record<string, unknown>): string | null {
  if (typeof value.thumbnail === "string" && value.thumbnail) {
    return value.thumbnail;
  }
  if (Array.isArray(value.thumbnails)) {
    const images = value.thumbnails.filter((
      item,
    ): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object")
    );
    const image = images.at(-1);
    if (image && typeof image.url === "string") return image.url;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isDownloadableMediaEntry(
  entry: Record<string, unknown>,
): boolean {
  const availability = asText(entry.availability).trim().toLowerCase();
  if (availability && availability !== "public") return false;
  if (entry.is_private === true) return false;

  const title = asText(entry.title).trim();
  if (!title) return false;
  const placeholder = title.replace(/^\[|\]$/g, "").trim();
  return !/^(?:private video|deleted video|unavailable video|video unavailable|members?[ -]?only(?: video| content)?|subscribers?[ -]?only(?: video| content)?|premium[ -]?only(?: video| content)?|paid content)$/i
    .test(placeholder);
}

async function inspectMedia(
  url: string,
  sourceType: SourceType,
  tools: SourceTools,
): Promise<InspectResult> {
  const args = [
    "--dump-single-json",
    "--flat-playlist",
    "--playlist-end",
    "500",
    "--extractor-args",
    "youtube:player_client=web_embedded,android_vr",
  ];
  if (tools.denoPath) args.push("--js-runtimes", `deno:${tools.denoPath}`);
  args.push(url);
  const output = await new Deno.Command(tools.ytDlpPath, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      error.split("\n").at(-1) || "The media source could not be inspected.",
    );
  }
  const data = JSON.parse(new TextDecoder().decode(output.stdout)) as Record<
    string,
    unknown
  >;
  const entries = Array.isArray(data.entries) ? data.entries : [data];
  const episodes = entries.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    if (!isDownloadableMediaEntry(entry)) return [];
    const id = asText(entry.id) ||
      stableId(asText(entry.url) || `${url}-${index}`);
    let episodeUrl = asText(entry.webpage_url) || asText(entry.url);
    if (
      sourceType === "youtube" && id &&
      (!episodeUrl || !episodeUrl.startsWith("http"))
    ) {
      episodeUrl = `https://www.youtube.com/watch?v=${id}`;
    }
    if (!episodeUrl) return [];
    const timestamp = typeof entry.timestamp === "number"
      ? new Date(entry.timestamp * 1000).toISOString()
      : null;
    const uploadDate = asText(entry.upload_date);
    const publishedAt = timestamp ||
      (uploadDate.length === 8
        ? normalizeDate(
          `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${
            uploadDate.slice(6, 8)
          }`,
        )
        : null);
    return [{
      id: stableId(`${sourceType}:${id}`),
      title: asText(entry.title) || `Episode ${index + 1}`,
      description: htmlToText(asText(entry.description)),
      publishedAt,
      durationSeconds: parseDuration(entry.duration),
      season: null,
      episode: typeof entry.playlist_index === "number"
        ? entry.playlist_index
        : index + 1,
      episodeType: "full" as const,
      sourceUrl: episodeUrl,
      thumbnailUrl: imageFromYtDlp(entry),
    }];
  });
  if (!episodes.length) {
    throw new Error("The source did not expose any downloadable episodes.");
  }
  return {
    sourceUrl: url,
    sourceType,
    title: asText(data.title) || asText(data.playlist_title) ||
      "Untitled series",
    author: asText(data.uploader) || asText(data.channel) ||
      asText(data.creator),
    description: htmlToText(asText(data.description)),
    language: asText(data.language),
    genres: [],
    coverUrl: imageFromYtDlp(data) ||
      episodes.find((episode) => episode.thumbnailUrl)?.thumbnailUrl || null,
    excludedEpisodeCount: entries.length - episodes.length,
    episodes,
  };
}

export async function inspectSource(
  url: string,
  tools: SourceTools,
): Promise<InspectResult> {
  const normalizedUrl = url.trim();
  await assertPublicRemoteUrl(normalizedUrl);
  const sourceType = detectSourceType(normalizedUrl);
  const inspectRssUrl = async () => {
    const response = await safeFetch(normalizedUrl, {
      headers: { "user-agent": "Castracker/0.2" },
    });
    if (!response.ok) {
      throw new Error(`RSS request failed with HTTP ${response.status}.`);
    }
    return parseRss(
      await readResponseText(response, 10 * 1024 * 1024),
      normalizedUrl,
    );
  };
  if (sourceType === "rss") return inspectRssUrl();
  if (sourceType === "media") {
    try {
      return await inspectMedia(normalizedUrl, sourceType, tools);
    } catch (mediaError) {
      try {
        return await inspectRssUrl();
      } catch {
        throw mediaError;
      }
    }
  }
  return inspectMedia(normalizedUrl, sourceType, tools);
}
