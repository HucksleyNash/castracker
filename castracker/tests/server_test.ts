import { isAbsolute, resolve } from "node:path";
import {
  localRequestViolation,
  normalizeLibraryPathInput,
  parseLaunchOptions,
} from "../server.ts";
import { assert, assertEquals, assertThrows } from "./test_helpers.ts";

Deno.test("library path validation resolves paths on the current OS", () => {
  const path = normalizeLibraryPathInput("castracker-library");
  assert(isAbsolute(path));
  assertEquals(path, resolve("castracker-library"));
});

if (Deno.build.os === "windows") {
  Deno.test("library path validation accepts a complete UNC path", () => {
    const path = normalizeLibraryPathInput(
      "\\\\192.168.0.140\\media\\podcasts",
    );
    assert(path.startsWith("\\\\192.168.0.140\\media\\podcasts"));
  });

  Deno.test("library path validation explains malformed UNC paths", () => {
    assertThrows(
      () => normalizeLibraryPathInput("\\\\192.168.0.140:\\podcasts"),
      /no colon after the server name/i,
    );
    assertThrows(
      () => normalizeLibraryPathInput("\\\\192.168.0.140"),
      /server\\share\\folder/i,
    );
  });
}

Deno.test("launch options support portable port arguments", () => {
  assertEquals(parseLaunchOptions(["--port=8788"]), { port: 8788 });
  assertEquals(parseLaunchOptions(["-p", "9000"]), { port: 9000 });
});

Deno.test("launch options reject unsafe or malformed ports", () => {
  assertThrows(() => parseLaunchOptions(["--port", "0"]), /1 to 65535/i);
  assertThrows(() => parseLaunchOptions(["--port=abc"]), /invalid port/i);
  assertThrows(() => parseLaunchOptions(["--host=0.0.0.0"]), /local-only/i);
  assertThrows(() => parseLaunchOptions(["--unknown"]), /unknown option/i);
});

Deno.test("local server boundary rejects remote hosts and origins", () => {
  assertEquals(
    localRequestViolation(
      new Request("http://127.0.0.1:8787/api/status", {
        headers: { origin: "http://127.0.0.1:8787" },
      }),
    ),
    null,
  );
  assertEquals(
    localRequestViolation(new Request("http://example.test:8787/api/status"))
      ?.status,
    421,
  );
  assertEquals(
    localRequestViolation(
      new Request("http://127.0.0.1:8787/api/status", {
        headers: { origin: "https://example.test" },
      }),
    )?.status,
    403,
  );
});
