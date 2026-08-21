const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function safeFilePart(value: string, maxLength = 150): string {
  let result = value.normalize("NFC")
    .replace(INVALID_FILE_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/[ .]+$/g, "")
    .replace(/^[ .]+/g, "")
    .slice(0, maxLength)
    .replace(/[ .]+$/g, "");
  if (!result) result = "Untitled";
  if (WINDOWS_RESERVED.has(result.toUpperCase())) result = `_${result}`;
  return result;
}

export function stableId(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function htmlToText(value: string): string {
  return decodeXml(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeXml(value: string): string {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) => String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&");
}

export function parseDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const parts = value.trim().split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temporary, path);
}

export function extensionFromUrl(url: string, fallback = ".audio"): string {
  try {
    const match = new URL(url).pathname.match(
      /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)$/i,
    );
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isInaccessibleMediaError(error: string | null): boolean {
  if (!error) return false;
  return /(?:private video|deleted video|unavailable video|video (?:is )?unavailable|removed by the uploader|members?[ -]?only|subscribers?[ -]?only|premium[ -]?only|paid content|purchase required|join this channel to get access|granted access to this video)/i
    .test(error);
}
