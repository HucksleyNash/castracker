import { isBlockedAddress, validateRemoteUrlSyntax } from "../network.ts";
import { assertEquals, assertThrows } from "./test_helpers.ts";

Deno.test("remote URL validation accepts public HTTP sources", () => {
  assertEquals(
    validateRemoteUrlSyntax("https://feeds.example.com/show.xml").hostname,
    "feeds.example.com",
  );
});

Deno.test("remote URL validation blocks credentials and local destinations", () => {
  for (
    const value of [
      "http://127.0.0.1/feed",
      "http://[::1]/feed",
      "http://router.local/feed",
      "http://user:pass@example.com/feed",
    ]
  ) {
    assertThrows(
      () => validateRemoteUrlSyntax(value),
      /credentials|local|private/i,
    );
  }
});

Deno.test("network address classification blocks non-public ranges", () => {
  for (
    const address of [
      "10.0.0.1",
      "100.64.1.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
    ]
  ) {
    assertEquals(isBlockedAddress(address), true);
  }
  assertEquals(isBlockedAddress("1.1.1.1"), false);
  assertEquals(isBlockedAddress("2606:4700:4700::1111"), false);
});
