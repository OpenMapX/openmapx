import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("source TAR reader memory bound", () => {
  it("reads a generated member larger than the child heap with bounded memory", async () => {
    const { stdout } = await execute(
      "apps/api/node_modules/.bin/tsx",
      ["apps/api/src/privacy/__tests__/fixtures/source-tar-memory-child.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=48" },
        maxBuffer: 16 * 1024,
        timeout: 60_000,
      },
    );
    const result = JSON.parse(stdout) as Record<string, number | string>;
    expect(result.bytes).toBe(192 * 1024 * 1024 + 17);
    expect(result.sha256).toBe("44a636ba8210259b33379975065e73bd8cadce2a4e571d9177f7792d88319a39");
    expect(result.members).toBe(1);
    // Leave room for GC of consumed chunk copies while rejecting retained member bodies.
    expect(result.peakExternal).toBeLessThan(48 * 1024 * 1024);
    expect(result.peakRss).toBeLessThan(160 * 1024 * 1024);
  });
});
