import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BIND_ADDRESS, bindAddress } from "../../lib/web/guards.js";

describe("bind address", () => {
  it("always listens on loopback", () => {
    expect(bindAddress({})).toBe(BIND_ADDRESS);
    expect(bindAddress({ HOST: "" })).toBe("127.0.0.1");
    expect(bindAddress({ HOST: "localhost" })).toBe("127.0.0.1");
  });

  it("refuses a LAN or wildcard HOST, since the server has no login", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20"]) {
      expect(() => bindAddress({ HOST })).toThrow(/not allowed/);
    }
  });

  it("will not start with HOST=0.0.0.0", () => {
    const main = fileURLToPath(new URL("../../lib/web/main.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", "tsx", main], {
      env: { ...process.env, HOST: "0.0.0.0", PORT: "8899", ANTHROPIC_API_KEY: "" },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("HOST=0.0.0.0 is not allowed");
  });
});
