import { isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    ((octets[0] << 24) >>> 0) +
    (octets[1] << 16) +
    (octets[2] << 8) +
    octets[3]
  ) >>> 0;
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) =>
    inIpv4Range(value, base as string, prefix as number)
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  const version = isIP(normalized);
  if (version === 4) return isBlockedIpv4(normalized);
  if (version === 6) return isBlockedIpv6(normalized);
  return true;
}

export function validateRemoteUrlSyntax(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only public HTTP and HTTPS links are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Source links cannot contain embedded credentials.");
  }
  const hostname = normalizedHostname(url.hostname);
  if (
    !hostname || hostname === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error(
      "Local and private-network source links are not supported.",
    );
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error(
      "Local and private-network source links are not supported.",
    );
  }
  return url;
}

export async function assertPublicRemoteUrl(value: string | URL): Promise<URL> {
  const url = validateRemoteUrlSyntax(value);
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) return url;

  const resolutions = await Promise.allSettled([
    Deno.resolveDns(hostname, "A"),
    Deno.resolveDns(hostname, "AAAA"),
  ]);
  const addresses = resolutions.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (!addresses.length) {
    throw new Error("The source hostname could not be resolved.");
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error(
      "Local and private-network source links are not supported.",
    );
  }
  return url;
}

export async function safeFetch(
  value: string | URL,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let url = await assertPublicRemoteUrl(value);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) {
      throw new Error("The remote server returned an invalid redirect.");
    }
    if (redirectCount === maxRedirects) {
      throw new Error("The remote server returned too many redirects.");
    }
    url = await assertPublicRemoteUrl(new URL(location, url));
  }
  throw new Error("The remote server returned too many redirects.");
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("The remote response is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("The remote response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}
