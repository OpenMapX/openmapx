import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cron module reaches drizzle at import time (module-level pool) and the
// ops agent from a few handlers. Neither is involved in these reads.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../ops-client.js", () => ({
  runOpsOperation: vi.fn(async () => ({ changed: true })),
}));

import { setupCron } from "../cron.js";
import { bakePredicted } from "../jobs/traffic/bake-predicted.js";
import { fetchCoveredWayIds } from "../jobs/traffic/covered-ways.js";
import { probeHttp } from "../jobs/transitous/motis-probe.js";

const OPEN_CONDITIONS_URL = "http://openconditions.test:4100";
const TOKEN = "op-token";
const HEADER_ONLY_CSV = "way_id,dir,current_kph,free_flow_kph,los\n";

type Seen = { url: string; authorization: string | undefined };

/** Routes the node:http getter through a recorder answering every OpenConditions path. */
function recordProbeRequests(): Seen[] {
  const seen: Seen[] = [];
  probeHttp.get = async (url, _timeoutMs, headers) => {
    seen.push({ url, authorization: headers?.["Authorization"] });
    if (url.endsWith("/segments/speed.csv")) return new Response(HEADER_ONLY_CSV);
    if (url.endsWith("/segments/profiles.json")) return new Response("[]");
    return new Response(JSON.stringify({ schema_version: 2, complete: true, conditions: [] }));
  };
  return seen;
}

describe("OpenConditions operator token", () => {
  const originalProbeGet = probeHttp.get;
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "openconditions-auth-"));
  });

  afterEach(() => {
    probeHttp.get = originalProbeGet;
    vi.unstubAllGlobals();
    rmSync(scratch, { recursive: true, force: true });
  });

  function cron(token: string | undefined) {
    return setupCron({
      dataDir: scratch,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      stalenessCheckCronExpression: "disabled",
      trafficExtractCronExpression: "disabled",
      trafficLiveCronExpression: "disabled",
      trafficPredictedCronExpression: "disabled",
      openConditionsUrl: OPEN_CONDITIONS_URL,
      openConditionsToken: token,
      roadConditionsMode: "shadow",
      readTrafficGraphState: async () => ({
        generation: "fixture-engine-epoch",
        engineBootId: "e2630bd0-5a85-4c93-9b7d-cf174bd0dd45",
      }),
      fetchTrafficPolicy: async () => ({
        revision: "p1",
        validUntil: new Date(Date.now() + 150_000).toISOString(),
        disallowedSourceIds: [],
      }),
      trafficTarPath: join(scratch, "traffic.tar"),
      trafficLiveStatePath: join(scratch, "live-state.json"),
      loadWaysToEdges: async () => new Map(),
      writeLiveTraffic: async () => ({
        written: 0,
        matched: 0,
        total: 0,
        outOfBounds: 0,
        closedEdges: 0,
        cappedEdges: 0,
        overridesUnresolved: 0,
        appliedObservationIds: [],
      }),
      spanEdgeCachePath: join(scratch, "span-edges-cache.json"),
    });
  }

  it("the live-traffic fetch sends the operator token", async () => {
    const seen = recordProbeRequests();
    const handles = cron(TOKEN);
    try {
      await handles.runTrafficLiveNow();
    } finally {
      handles.stop();
    }
    expect(seen.map((s) => s.url).sort()).toEqual([
      `${OPEN_CONDITIONS_URL}/segments/conditions.json`,
      `${OPEN_CONDITIONS_URL}/segments/speed.csv`,
    ]);
    expect(seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("the live-traffic fetch sends no Authorization header without a token", async () => {
    const seen = recordProbeRequests();
    const handles = cron(undefined);
    try {
      await handles.runTrafficLiveNow();
    } finally {
      handles.stop();
    }
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("the covered-way read sends the operator token to all three feeds", async () => {
    const seen = recordProbeRequests();
    await fetchCoveredWayIds(OPEN_CONDITIONS_URL, TOKEN);
    expect(seen.map((s) => s.url.slice(OPEN_CONDITIONS_URL.length)).sort()).toEqual([
      "/segments/conditions.json",
      "/segments/profiles.json",
      "/segments/speed.csv",
    ]);
    expect(seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("the predicted-profile fetch sends the operator token", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    // Every later step is stubbed: an empty profile feed bakes nothing and
    // stops before the tiles and the operations agent.
    const result = await bakePredicted({
      openConditionsUrl: OPEN_CONDITIONS_URL,
      openConditionsToken: TOKEN,
      csvDir: scratch,
      preparedGeneration: "22222222-2222-4222-8222-222222222222",
      getCoveredWayIds: async () => new Set(),
      loadWaysToEdges: async () => new Map(),
      refreshWaysToEdges: async () => ({ wayCount: 0, edgeCount: 0 }),
    });
    expect(result).toMatchObject({ segments: 0, rows: 0, tiles: 0, built: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `${OPEN_CONDITIONS_URL}/segments/profiles.json`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
  });
});
