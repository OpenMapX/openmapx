import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as resources from "../../src/jobs/search-index/extract.js";

afterEach(() => vi.unstubAllEnvs());
it("puts planet node locations on disk and removes them after export failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "planet-index-"));
  vi.stubEnv("OSMIUM_PLANET_INDEX_ESTIMATE_BYTES", "1");
  let path = "";
  try {
    await expect(
      resources.withOsmiumLocationIndex("planet", dir, async (args) => {
        expect(args[0]).toMatch(/^--index-type=dense_file_array,/);
        path = args[0].split(",")[1];
        writeFileSync(path, "fixture");
        throw new Error("export failed");
      }),
    ).rejects.toThrow("export failed");
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
    vi.stubEnv("OSMIUM_PLANET_INDEX_ESTIMATE_BYTES", "9007199254740991");
    await expect(
      resources.withOsmiumLocationIndex("planet", dir, async () => undefined),
    ).rejects.toThrow(/disk/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
