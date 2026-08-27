import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opsCalls: unknown[] = [];
// Shared with the per-test `callOrder` so agent operations and the remaining
// local steps can be ordered against each other.
const opsOrder: string[] = [];
const opsBehaviour = { fail: false };
vi.mock("../ops-client.js", () => ({
  runOpsOperation: vi.fn(async (operation: { kind: string }) => {
    opsCalls.push(operation);
    opsOrder.push(`ops:${operation.kind}`);
    if (opsBehaviour.fail && operation.kind === "valhalla.traffic.applyPredicted") {
      throw new Error("Operation valhalla.traffic.applyPredicted did not succeed (runtime)");
    }
    return { changed: true };
  }),
}));

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
    callOrder = opsOrder;
    opsOrder.length = 0;
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
      container: "docker-valhalla-1",
      getCoveredWayIds: async () => new Set([3001]),
      fetchProfiles: async () => profiles,
      loadWaysToEdges: async () => waysToEdges,
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

  const profileFor = (wayId: string, dir: "f" | "b" = "f"): ProfileSegment => ({
    way_id: wayId,
    dir,
    free_flow_kph: 100,
    constrained_kph: 90,
    hourly: flatHourly(80),
  });

  const edgeAt = (index: number, forward = true): WayEdge => ({
    forward,
    level: 0,
    tile: 3196,
    index,
  });

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

  it("bakes through the typed agent operation, naming no container or csv path", async () => {
    opsCalls.length = 0;
    await bakePredicted(makeDeps());
    expect(opsCalls).toContainEqual({ kind: "valhalla.traffic.applyPredicted" });
    const serialized = JSON.stringify(opsCalls);
    for (const forbidden of ["docker-valhalla-1", "/custom_files", "predicted-csv"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.skip("runs the valhalla_add_predicted_traffic exec with the container-visible csvdir", async () => {
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

  it("refreshes the way-to-edge map BEFORE reading it, then bakes and rebuilds the extract", async () => {
    await bakePredicted(makeDeps());

    // Exactly one refresh, and it must precede the bake. Reading a map written
    // by an earlier, unrelated job is what made a production bake emit 33 of
    // 2,787 rows.
    expect(refreshWaysCalls).toHaveLength(1);
    expect([...refreshWaysCalls[0]].sort()).toEqual([3001]);
    expect(ensureExtractCalls).toEqual([{ force: true }]);

    // Valhalla must restart exactly once — from ensureTrafficExtract's own
    // internal restart. bakePredicted must NOT issue a second restart.
    const restartCount = dockerCalls.filter((args) => args[0] === "restart").length;
    expect(restartCount).toBe(1);

    const bakeIndex = callOrder.indexOf("ops:valhalla.traffic.applyPredicted");
    const ensureIndex = callOrder.indexOf("ensureTrafficExtract");
    const restartIndex = callOrder.indexOf("docker:restart");

    const refreshIndex = callOrder.indexOf("refreshWaysToEdges");
    expect(refreshIndex).toBe(0);
    expect(refreshIndex).toBeLessThan(bakeIndex);
    expect(bakeIndex).toBeLessThan(ensureIndex);
    expect(ensureIndex).toBeLessThan(restartIndex);
  });

  it("aborts before any docker call when the pre-bake map refresh fails", async () => {
    await expect(
      bakePredicted(
        makeDeps({
          refreshWaysToEdges: async () => {
            throw new Error("valhalla_ways_to_edges exited 1");
          },
        }),
      ),
    ).rejects.toThrow(/valhalla_ways_to_edges exited 1/);

    // Never fall back to the map on disk: proceeding on a stale map is the
    // failure this whole change exists to prevent.
    expect(dockerCalls).toHaveLength(0);
    expect(ensureExtractCalls).toHaveLength(0);
  });

  it("propagates a failed bake operation and skips the rebuild chain", async () => {
    opsBehaviour.fail = true;
    try {
      const calls: unknown[] = [];
      await expect(
        bakePredicted(
          makeDeps({
            ensureTrafficExtract: async (d) => {
              calls.push(d);
              return { built: true };
            },
          }),
        ),
      ).rejects.toThrow(/did not succeed/);
      // A failed bake must not trigger the extract rebuild + Valhalla restart.
      expect(calls).toEqual([]);
    } finally {
      opsBehaviour.fail = false;
    }
  });

  it.skip("throws when valhalla_add_predicted_traffic exits non-zero and skips the rebuild chain", async () => {
    await expect(bakePredicted(makeDeps({}))).rejects.toThrow(
      /valhalla_add_predicted_traffic exited 1/,
    );

    expect(ensureExtractCalls).toHaveLength(0);
    // The refresh moved to the front of the bake, so it has already run.
    expect(refreshWaysCalls).toHaveLength(1);
  });

  it("reports matched and matchRatePct over map-resolvable profiles", async () => {
    // Three profiles: two resolve, one is for a way outside the graph.
    const waysToEdges = new Map<number, WayEdge[]>([
      [1, [edgeAt(10)]],
      [2, [edgeAt(11)]],
    ]);
    const result = await bakePredicted(
      makeDeps({
        fetchProfiles: async () => [profileFor("1"), profileFor("2"), profileFor("999")],
        loadWaysToEdges: async () => waysToEdges,
      }),
    );

    expect(result.segments).toBe(3);
    expect(result.resolvable).toBe(2);
    expect(result.matched).toBe(2);
    // 999 is not in the map, so it is not counted against the rate.
    expect(result.matchRatePct).toBe(100);
  });

  it("warns when the rate falls below fifty percent", async () => {
    // Four resolvable ways; only one has an edge in the profile's direction.
    const waysToEdges = new Map<number, WayEdge[]>([
      [1, [edgeAt(10, true)]],
      [2, [edgeAt(11, false)]],
      [3, [edgeAt(12, false)]],
      [4, [edgeAt(13, false)]],
    ]);
    const warn = vi.fn();
    await bakePredicted(
      makeDeps({
        fetchProfiles: async () => [
          profileFor("1"),
          profileFor("2"),
          profileFor("3"),
          profileFor("4"),
        ],
        loadWaysToEdges: async () => waysToEdges,
        logger: { info: () => {}, warn },
      }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ resolvable: 4, matched: 1, matchRatePct: 25 });
  });

  it("does not warn at a healthy rate", async () => {
    const warn = vi.fn();
    await bakePredicted(makeDeps({ logger: { info: () => {}, warn } }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the map covers too little of the feed, which matchRatePct cannot see", async () => {
    // The shape of the 2026-07-27 incident: a wide feed, a map holding almost
    // none of it, and every way it does hold matching perfectly. matchRatePct
    // reads 100 here — only coverageRatePct moves.
    const profiles = Array.from({ length: 100 }, (_, i) => profileFor(String(i + 1)));
    const waysToEdges = new Map<number, WayEdge[]>([
      [1, [edgeAt(10)]],
      [2, [edgeAt(11)]],
    ]);
    const warn = vi.fn();
    const result = await bakePredicted(
      makeDeps({
        fetchProfiles: async () => profiles,
        loadWaysToEdges: async () => waysToEdges,
        logger: { info: () => {}, warn },
      }),
    );

    expect(result.matchRatePct).toBe(100);
    expect(result.coverageRatePct).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("covers too little");
  });

  it("skips the bake tool and the extract rebuild when nothing matched, but keeps the refresh", async () => {
    const warn = vi.fn();
    const result = await bakePredicted(
      makeDeps({
        fetchProfiles: async () => [profileFor("999")],
        loadWaysToEdges: async () => new Map<number, WayEdge[]>(),
        logger: { info: () => {}, warn },
      }),
    );

    expect(dockerCalls).toHaveLength(0);
    expect(ensureExtractCalls).toHaveLength(0);
    // The refresh must still have run — it is the only thing that can recover a
    // stale map, so skipping it would make a zero-row bake permanent.
    expect(refreshWaysCalls).toHaveLength(1);
    expect(result.rows).toBe(0);
    expect(result.tiles).toBe(0);
    expect(result.built).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
