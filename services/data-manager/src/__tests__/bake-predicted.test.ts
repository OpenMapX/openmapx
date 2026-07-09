import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BakePredictedDeps,
  bakePredicted,
  type ProfileSegment,
} from "../jobs/traffic/bake-predicted.js";
import { encodePredictedSpeeds, expandHourlyToBuckets } from "../jobs/traffic/predicted-encode.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";

describe("tileSuffix", () => {
  it("matches the validated FileSuffix examples", async () => {
    const { tileSuffix } = await import("../jobs/traffic/bake-predicted.js");
    expect(tileSuffix(0, 3198)).toBe("0/003/198");
    expect(tileSuffix(1, 51313)).toBe("1/051/313");
    expect(tileSuffix(2, 820133)).toBe("2/000/820/133");
  });

  it("pads a small level-2 tileid to the level's full width", async () => {
    const { tileSuffix } = await import("../jobs/traffic/bake-predicted.js");
    expect(tileSuffix(2, 5)).toBe("2/000/000/005");
  });
});

function flatHourly(kph: number): number[] {
  return Array<number>(168).fill(kph);
}

function expectedBase64(kph: number, freeFlow: number): string {
  return encodePredictedSpeeds(expandHourlyToBuckets(flatHourly(kph), freeFlow));
}

describe("bakePredicted", () => {
  let csvDir: string;
  let dockerCalls: string[][];
  let ensureExtractCalls: Array<{ force?: boolean }>;
  let refreshWaysCalls: Array<Set<number>>;
  let callOrder: string[];

  beforeEach(() => {
    csvDir = mkdtempSync(join(tmpdir(), "bake-predicted-"));
    dockerCalls = [];
    ensureExtractCalls = [];
    refreshWaysCalls = [];
    callOrder = [];
  });

  afterEach(() => {
    rmSync(csvDir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<BakePredictedDeps> = {}): BakePredictedDeps {
    const profiles: ProfileSegment[] = overrides.fetchProfiles
      ? []
      : [
          {
            way_id: "3001",
            dir: "f",
            free_flow_kph: 50,
            constrained_kph: 30,
            hourly: flatHourly(50),
          },
          {
            way_id: "3001",
            dir: "b",
            free_flow_kph: 50,
            constrained_kph: 30,
            hourly: flatHourly(20),
          },
        ];

    const waysToEdges = new Map<number, WayEdge[]>([
      [
        3001,
        [
          { forward: true, level: 0, tile: 3198, index: 5 },
          { forward: false, level: 1, tile: 51313, index: 9 },
        ],
      ],
    ]);

    const runDocker = async (args: string[]) => {
      dockerCalls.push(args);
      callOrder.push(`docker:${args[0]}`);
      return { exitCode: 0, stdout: "" };
    };

    return {
      openConditionsUrl: "http://openconditions.local",
      csvDir,
      containerCsvDir: "/custom_files/predicted-csv",
      container: "docker-valhalla-1",
      fetchProfiles: async () => profiles,
      loadWaysToEdges: async () => waysToEdges,
      runDocker,
      ensureTrafficExtract: async (deps) => {
        ensureExtractCalls.push(deps);
        callOrder.push("ensureTrafficExtract");
        // The real ensureTrafficExtract({ force: true }) restarts Valhalla
        // itself after rebuilding the extract. Model that here so a second,
        // redundant restart from bakePredicted would surface as two restarts.
        await runDocker(["restart", "docker-valhalla-1"]);
        return { built: true };
      },
      refreshWaysToEdges: async (coveredWayIds) => {
        refreshWaysCalls.push(coveredWayIds);
        callOrder.push("refreshWaysToEdges");
        return { wayCount: coveredWayIds.size, edgeCount: 2 };
      },
      ...overrides,
    };
  }

  it("writes one CSV per tile at its tileSuffix path with the forward-matching row only", async () => {
    const result = await bakePredicted(makeDeps());

    // way 3001 has one forward edge (level 0, tile 3198) and one backward
    // edge (level 1, tile 51313). The "f" profile matches the forward edge;
    // the "b" profile matches the backward edge. Each profile produces
    // exactly one row because each way has exactly one matching-direction edge.
    const forwardPath = join(csvDir, "0", "003", "198.csv");
    const backwardPath = join(csvDir, "1", "051", "313.csv");

    const forwardCsv = readFileSync(forwardPath, "utf8");
    const backwardCsv = readFileSync(backwardPath, "utf8");

    const forwardBase64 = expectedBase64(50, 50);
    const backwardBase64 = expectedBase64(20, 50);

    expect(forwardCsv).toBe(`0/3198/5,50,30,${forwardBase64}\n`);
    expect(backwardCsv).toBe(`1/51313/9,50,30,${backwardBase64}\n`);

    expect(result.segments).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.tiles).toBe(2);
  });

  it("excludes a non-matching-direction edge (b edge for an f profile)", async () => {
    const waysToEdges = new Map<number, WayEdge[]>([
      [4002, [{ forward: false, level: 0, tile: 10, index: 0 }]],
    ]);
    const profiles: ProfileSegment[] = [
      { way_id: "4002", dir: "f", free_flow_kph: 60, constrained_kph: 40, hourly: flatHourly(60) },
    ];

    const result = await bakePredicted(
      makeDeps({ fetchProfiles: async () => profiles, loadWaysToEdges: async () => waysToEdges }),
    );

    expect(result.rows).toBe(0);
    expect(result.tiles).toBe(0);
  });

  it("runs the valhalla_add_predicted_traffic exec with the container-visible csvdir", async () => {
    await bakePredicted(makeDeps());
    const bakeCall = dockerCalls.find((args) => args.includes("valhalla_add_predicted_traffic"));
    expect(bakeCall).toEqual([
      "exec",
      "docker-valhalla-1",
      "valhalla_add_predicted_traffic",
      "-c",
      "/custom_files/valhalla.json",
      "/custom_files/predicted-csv",
    ]);
  });

  it("defaults the host CSV dir to the valhalla/osm-pbf mount both containers share (not /data/osm)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bake-predicted-data-"));
    const prev = process.env.DATA_DIR;
    const prevCsvDir = process.env.TRAFFIC_PREDICTED_CSV_DIR;
    process.env.DATA_DIR = dataDir;
    delete process.env.TRAFFIC_PREDICTED_CSV_DIR;
    try {
      const deps = makeDeps();
      // Exercise the real default by dropping the explicit csvDir override.
      deps.csvDir = undefined;
      await bakePredicted(deps);

      // Valhalla's /custom_files == host data/valhalla/osm-pbf; data-manager
      // reaches the SAME host dir at /data/valhalla/osm-pbf. Writing to
      // /data/osm (the produce/hardlink dir) would make the bake a no-op.
      const expected = join(dataDir, "valhalla", "osm-pbf", "predicted-csv", "0", "003", "198.csv");
      expect(readFileSync(expected, "utf8")).toContain("0/3198/5,50,30,");
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
      if (prevCsvDir === undefined) delete process.env.TRAFFIC_PREDICTED_CSV_DIR;
      else process.env.TRAFFIC_PREDICTED_CSV_DIR = prevCsvDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("runs the rebuild chain in order after the bake: bake -> ensureTrafficExtract(force) [restarts once] -> refreshWaysToEdges", async () => {
    await bakePredicted(makeDeps());

    expect(ensureExtractCalls).toEqual([{ force: true }]);
    expect(refreshWaysCalls).toHaveLength(1);
    expect([...refreshWaysCalls[0]].sort()).toEqual([3001]);

    // Valhalla must restart exactly once — from ensureTrafficExtract's own
    // internal restart. bakePredicted must NOT issue a second restart.
    const restartCount = dockerCalls.filter((args) => args[0] === "restart").length;
    expect(restartCount).toBe(1);

    const bakeIndex = callOrder.indexOf("docker:exec");
    const ensureIndex = callOrder.indexOf("ensureTrafficExtract");
    const restartIndex = callOrder.indexOf("docker:restart");
    const refreshIndex = callOrder.indexOf("refreshWaysToEdges");

    expect(bakeIndex).toBeGreaterThanOrEqual(0);
    // bake -> ensureTrafficExtract -> its restart -> refreshWaysToEdges
    expect(bakeIndex).toBeLessThan(ensureIndex);
    expect(ensureIndex).toBeLessThan(restartIndex);
    expect(restartIndex).toBeLessThan(refreshIndex);
  });

  it("throws when valhalla_add_predicted_traffic exits non-zero and skips the rebuild chain", async () => {
    await expect(
      bakePredicted(
        makeDeps({
          runDocker: async (args) => {
            dockerCalls.push(args);
            if (args.includes("valhalla_add_predicted_traffic")) {
              return { exitCode: 1, stdout: "" };
            }
            return { exitCode: 0, stdout: "" };
          },
        }),
      ),
    ).rejects.toThrow(/valhalla_add_predicted_traffic exited 1/);

    expect(ensureExtractCalls).toHaveLength(0);
    expect(refreshWaysCalls).toHaveLength(0);
  });
});
