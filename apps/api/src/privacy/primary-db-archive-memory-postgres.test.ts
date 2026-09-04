import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "primary database archive memory bound",
  () => {
    it("collects and assembles source data larger than its V8 heap", async () => {
      const { stdout } = await execute(
        "apps/api/node_modules/.bin/tsx",
        ["apps/api/src/privacy/__tests__/fixtures/primary-db-archive-memory-child.ts"],
        {
          cwd: process.cwd(),
          env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=64" },
          maxBuffer: 16 * 1024,
          timeout: 120_000,
        },
      );
      const result = JSON.parse(stdout) as Record<string, number | string>;
      expect(result.sourceBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(result.records).toBe(60_000);
      expect(result.portableRecords).toBe(60_000);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.schemaId).toBe("article-15-record-v1");
      expect(result.peakExternal).toBeLessThan(48 * 1024 * 1024);
      expect(result.peakRss).toBeLessThan(320 * 1024 * 1024);
    }, 150_000);
  },
);
