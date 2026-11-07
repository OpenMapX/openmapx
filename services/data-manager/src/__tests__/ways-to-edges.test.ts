import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opsCalls: unknown[] = [];
vi.mock("../ops-client.js", () => ({
  runOpsOperation: vi.fn(async (operation: unknown) => {
    opsCalls.push(operation);
    return { changed: true };
  }),
}));

import {
  decodeGraphId,
  loadWaysToEdges,
  refreshWaysToEdges,
  type WayEdge,
} from "../jobs/traffic/ways-to-edges.js";

describe("decodeGraphId", () => {
  it("decodes a hand-packed GraphId (level=2, tile=818660, index=5)", () => {
    const raw = 2n | (818660n << 3n) | (5n << 25n);
    expect(decodeGraphId(raw)).toEqual({ level: 2, tile: 818660, index: 5 });
  });

  it("decodes an all-zero GraphId", () => {
    expect(decodeGraphId(0n)).toEqual({ level: 0, tile: 0, index: 0 });
  });

  it("decodes the maximum value in each field (7 / 2^22-1 / 2^21-1)", () => {
    const raw = 7n | (0x3fffffn << 3n) | (0x1fffffn << 25n);
    expect(decodeGraphId(raw)).toEqual({ level: 7, tile: 4194303, index: 2097151 });
  });

  it("matches the sample way_edges.txt GraphIds from the plan doc", () => {
    expect(decodeGraphId(73160266n)).toEqual({ level: 2, tile: 756425, index: 2 });
    expect(decodeGraphId(110268746n)).toEqual({ level: 2, tile: 1200681, index: 3 });
  });
});

describe("refreshWaysToEdges / loadWaysToEdges", () => {
  let dataDir: string;
  let outputPath: string;
  const writeEdges = async (path: string, lines: string[]) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lines.join("\n") + "\n");
  };
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ways-to-edges-"));
    outputPath = join(dataDir, "traffic", "ways_to_edges.json");
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("TRAFFIC_TAR_PATH", "");
    opsCalls.length = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });
  it("runs the typed agent operation and streams only covered forward/back edges into the map", async () => {
    await writeEdges(join(dataDir, "valhalla", "osm-pbf", "valhalla_tiles", "way_edges.txt"), [
      "123,1,73160266,0,110268746",
      "999,1,555",
    ]);
    const result = await refreshWaysToEdges(new Set([123]));
    expect(opsCalls).toEqual([{ kind: "valhalla.traffic.refreshWaysToEdges" }]);
    expect(result).toEqual({ wayCount: 1, edgeCount: 2 });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual({
      "123": [
        { forward: true, level: 2, tile: 756425, index: 2 },
        { forward: false, level: 2, tile: 1200681, index: 3 },
      ],
    });
    const loaded = await loadWaysToEdges({ path: outputPath });
    const expected: Map<number, WayEdge[]> = new Map([
      [
        123,
        [
          { forward: true, level: 2, tile: 756425, index: 2 },
          { forward: false, level: 2, tile: 1200681, index: 3 },
        ],
      ],
    ]);
    expect(loaded).toEqual(expected);
  });
  it("reads the real default tile directory and the tile directory beside an overridden traffic.tar", async () => {
    await writeEdges(join(dataDir, "valhalla", "osm-pbf", "valhalla_tiles", "way_edges.txt"), [
      "1,1,73160266",
    ]);
    await refreshWaysToEdges(new Set([1]));
    expect(Object.keys(JSON.parse(await readFile(outputPath, "utf8")))).toEqual(["1"]);
    vi.stubEnv("TRAFFIC_TAR_PATH", join(dataDir, "alternate", "traffic.tar"));
    await writeEdges(join(dataDir, "alternate", "valhalla_tiles", "way_edges.txt"), [
      "2,0,110268746",
    ]);
    await refreshWaysToEdges(new Set([2]));
    expect(Object.keys(JSON.parse(await readFile(outputPath, "utf8")))).toEqual(["2"]);
  });
  it("propagates a failed agent operation instead of reading or writing a map", async () => {
    const { runOpsOperation } = await import("../ops-client.js");
    vi.mocked(runOpsOperation).mockRejectedValueOnce(
      new Error("Operation valhalla.traffic.refreshWaysToEdges did not succeed (runtime)"),
    );
    await expect(refreshWaysToEdges(new Set([123]))).rejects.toThrow(/did not succeed/);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("writes an empty map when coveredWayIds matches nothing", async () => {
    await writeEdges(join(dataDir, "valhalla", "osm-pbf", "valhalla_tiles", "way_edges.txt"), [
      "999,1,555",
    ]);
    expect(await refreshWaysToEdges(new Set([1]))).toEqual({ wayCount: 0, edgeCount: 0 });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({});
  });
});
