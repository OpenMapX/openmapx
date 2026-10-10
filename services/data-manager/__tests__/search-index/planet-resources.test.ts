import { existsSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as resources from "../../src/jobs/search-index/extract.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(statfsSync).mockReset();
});

it.each(["", " \t "])(
  "uses the planet node-index disk reserve for a blank setting %j",
  async (value) => {
    vi.stubEnv("OSMIUM_PLANET_INDEX_ESTIMATE_BYTES", value);
    const fs = {
      type: 0,
      bsize: 1,
      frsize: 1,
      blocks: 0,
      bfree: 0,
      bavail: 133 * 1024 ** 3,
      files: 0,
      ffree: 0,
    };
    vi.mocked(statfsSync).mockReturnValue(fs);
    const args = await resources.withOsmiumLocationIndex("planet", tmpdir(), async (args) => args);
    expect(args[0]).toMatch(/^--index-type=dense_file_array,/);
    vi.mocked(statfsSync).mockReturnValue({ ...fs, bavail: fs.bavail - 1 });
    await expect(
      resources.withOsmiumLocationIndex("planet", tmpdir(), async () => undefined),
    ).rejects.toThrow(/disk/i);
  },
);
it("puts planet node locations on disk and removes them after export failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "planet-index-"));
  vi.mocked(statfsSync).mockReturnValue({
    type: 0,
    bsize: 1,
    frsize: 1,
    blocks: 0,
    bfree: 0,
    bavail: 133 * 1024 ** 3,
    files: 0,
    ffree: 0,
  });
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
