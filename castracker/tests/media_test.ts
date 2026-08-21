import { formatTransferProgress, parseYtDlpProgress } from "../media.ts";
import { assertEquals } from "./test_helpers.ts";

Deno.test("transfer progress includes size, speed, and ETA", () => {
  assertEquals(
    formatTransferProgress(
      5 * 1_048_576,
      10 * 1_048_576,
      2 * 1_048_576,
      2.5,
    ),
    "Downloading · 5.0 MB / 10.0 MB · 2.0 MB/s · ETA 3s",
  );
  assertEquals(
    formatTransferProgress(512 * 1024, null, 128 * 1024, null),
    "Downloading · 512 KB · 128 KB/s",
  );
});

Deno.test("yt-dlp progress lines tolerate estimated and unavailable values", () => {
  assertEquals(
    parseYtDlpProgress(
      "__CASTRACKER_PROGRESS__5242880|NA|10485760|2097152|3",
    ),
    {
      downloaded: 5_242_880,
      total: 10_485_760,
      speed: 2_097_152,
      etaSeconds: 3,
    },
  );
  assertEquals(parseYtDlpProgress("ordinary output"), null);
});
