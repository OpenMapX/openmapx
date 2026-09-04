import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("primary export memory bound", () => {
  it("encodes a source larger than the child heap with bounded RSS and external memory", async () => {
    const { stdout } = await execute(
      "apps/api/node_modules/.bin/tsx",
      ["apps/api/src/privacy/__tests__/fixtures/primary-stream-memory-child.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=48" },
        maxBuffer: 16 * 1024,
        timeout: 60_000,
      },
    );
    const result = JSON.parse(stdout) as Record<string, number | string>;
    expect(result.bytes).toBeGreaterThan(192 * 1024 * 1024);
    expect(result.sha256).toBe(result.observedSha256);
    expect(result.peakExternal).toBeLessThan(24 * 1024 * 1024);
    expect(result.peakRss).toBeLessThan(160 * 1024 * 1024);
  });
});
