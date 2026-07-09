import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeGraphId,
  loadWaysToEdges,
  refreshWaysToEdges,
  type WayEdge,
} from "../jobs/traffic/ways-to-edges.js";

async function* linesOf(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

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

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ways-to-edges-"));
    outputPath = join(dataDir, "traffic", "ways_to_edges.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("runs valhalla_ways_to_edges, then keeps only covered way ids with decoded f/b edges", async () => {
    const calls: string[][] = [];
    const sampleLines = ["123,1,73160266,0,110268746", "999,1,555"];

    const result = await refreshWaysToEdges(new Set([123]), {
      container: "docker-valhalla-1",
      runDocker: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "" };
      },
      readWayEdgesLines: async function* (container, path) {
        expect(container).toBe("docker-valhalla-1");
        expect(path).toBe("/custom_files/valhalla_tiles/way_edges.txt");
        yield* linesOf(sampleLines);
      },
      outputPath,
    });

    expect(calls).toEqual([
      ["exec", "docker-valhalla-1", "valhalla_ways_to_edges", "-c", "/custom_files/valhalla.json"],
    ]);
    expect(result).toEqual({ wayCount: 1, edgeCount: 2 });

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual({
      "123": [
        { forward: true, level: 2, tile: 756425, index: 2 },
        { forward: false, level: 2, tile: 1200681, index: 3 },
      ],
    });
    // 999 was not in coveredWayIds and must not appear.
    expect(written["999"]).toBeUndefined();

    const loaded = await loadWaysToEdges({ path: outputPath });
    expect(loaded).toBeInstanceOf(Map);
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
    expect(loaded.has(999)).toBe(false);
  });

  it("throws when valhalla_ways_to_edges exits non-zero", async () => {
    await expect(
      refreshWaysToEdges(new Set([123]), {
        container: "docker-valhalla-1",
        runDocker: async () => ({ exitCode: 1, stdout: "" }),
        readWayEdgesLines: async function* () {},
        outputPath,
      }),
    ).rejects.toThrow(/valhalla_ways_to_edges exited 1/);
  });

  it("writes an empty map when coveredWayIds matches nothing", async () => {
    const result = await refreshWaysToEdges(new Set([1]), {
      container: "docker-valhalla-1",
      runDocker: async () => ({ exitCode: 0, stdout: "" }),
      readWayEdgesLines: async function* () {
        yield* linesOf(["999,1,555"]);
      },
      outputPath,
    });

    expect(result).toEqual({ wayCount: 0, edgeCount: 0 });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual({});
  });
});
