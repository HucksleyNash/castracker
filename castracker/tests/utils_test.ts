import {
  decodeXml,
  extensionFromUrl,
  isInaccessibleMediaError,
  parseDuration,
  safeFilePart,
  stableId,
} from "../utils.ts";
import { assert, assertEquals } from "./test_helpers.ts";

Deno.test("safeFilePart produces Windows-safe stable names", () => {
  assertEquals(safeFilePart("CON"), "_CON");
  assertEquals(safeFilePart(`a/b\\c*?"<>|. `), "a-b-c-");
  assertEquals(safeFilePart("   "), "Untitled");
  assert(safeFilePart("x".repeat(200), 30).length <= 30);
});

Deno.test("stableId is deterministic and distinguishes inputs", () => {
  assertEquals(stableId("episode-1"), stableId("episode-1"));
  assert(stableId("episode-1") !== stableId("episode-2"));
});

Deno.test("duration, entities, and URL extensions are normalized", () => {
  assertEquals(parseDuration("01:02:03"), 3723);
  assertEquals(parseDuration("12:34"), 754);
  assertEquals(parseDuration(4.6), 5);
  assertEquals(parseDuration("bad"), null);
  assertEquals(decodeXml("A &amp; B &#x2014; &#169;"), "A & B — ©");
  assertEquals(extensionFromUrl("https://example.test/audio.MP3?x=1"), ".mp3");
  assertEquals(
    extensionFromUrl("https://example.test/no-extension", ".bin"),
    ".bin",
  );
});

Deno.test("inaccessible media errors are distinguished from retryable failures", () => {
  assertEquals(
    isInaccessibleMediaError("Video unavailable. Removed by the uploader"),
    true,
  );
  assertEquals(
    isInaccessibleMediaError("This is members-only content"),
    true,
  );
  assertEquals(
    isInaccessibleMediaError("Connection reset while downloading"),
    false,
  );
});
