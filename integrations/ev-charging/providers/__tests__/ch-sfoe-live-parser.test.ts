import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChSfoeOicpLive } from "../ch-sfoe-live-parser.js";
import { mergeChSfoeLive } from "../ch-sfoe-mapper.js";

const STATUS_FIXTURE = readFileSync(join(__dirname, "fixtures", "switzerland-status-sample.json"));
const DATA_FIXTURE = readFileSync(join(__dirname, "fixtures", "switzerland-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function installDataFeedFetchStub(): void {
  // Why a fetch stub instead of a real network call: the live parser
  // intentionally pulls the static data feed to resolve EvseID→station
  // mappings each run. Tests must exercise that branch without hitting
  // opendata.swiss.
  const fakeFetch = vi.fn(
    async () =>
      new Response(DATA_FIXTURE as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fakeFetch);
}

describe("parseChSfoeOicpLive", () => {
  beforeEach(() => {
    installDataFeedFetchStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces one PoiLiveState per station keyed by encoded ChargingStationId", async () => {
    const out = await parseChSfoeOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.size).toBe(3);
    expect(out.has(encodeURIComponent("CH-GRN-S001"))).toBe(true);
    expect(out.has(encodeURIComponent("CH-GRN-S002"))).toBe(true);
    expect(out.has(encodeURIComponent("CH*STATION*1"))).toBe(true);
  });

  it("emits available/total EVSE counts per station", async () => {
    // fixture station CH*STATION*1 has 3 EVSEs: AVAILABLE, CHARGING, OUTOFORDER
    const out = await parseChSfoeOicpLive(STATUS_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("CH*STATION*1"));
    expect(state).toBeDefined();
    expect(state?.total).toBe(3);
    expect(state?.available).toBe(1); // only the AVAILABLE evse counts as free
  });

  it("counts an EVSE with an unrecognized raw status toward total but not available", async () => {
    const dataFeed = {
      EVSEData: [
        {
          OperatorID: "CH*TEST",
          EVSEDataRecord: [
            { ChargingStationId: "CH-TEST-S001", EvseID: "CH*TEST*E1" },
            { ChargingStationId: "CH-TEST-S001", EvseID: "CH*TEST*E2" },
          ],
        },
      ],
    };
    const statusFeed = {
      EVSEStatuses: [
        {
          OperatorID: "CH*TEST",
          EVSEStatusRecord: [
            { EvseID: "CH*TEST*E1", EVSEStatus: "AVAILABLE" },
            { EvseID: "CH*TEST*E2", EVSEStatus: "FAULTED" },
          ],
        },
      ],
    };
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(dataFeed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const out = await parseChSfoeOicpLive(Buffer.from(JSON.stringify(statusFeed)), {
      log: noopLog,
    });
    const state = out.get(encodeURIComponent("CH-TEST-S001"));
    expect(state).toBeDefined();
    expect(state?.total).toBe(2); // both EVSEs count, even the unrecognized one
    expect(state?.available).toBe(1);
  });

  it("excludes REMOVED EVSEs from total while still counting AVAILABLE/CHARGING", async () => {
    const dataFeed = {
      EVSEData: [
        {
          OperatorID: "CH*REM",
          EVSEDataRecord: [
            { ChargingStationId: "CH-REM-S001", EvseID: "CH*REM*E1" },
            { ChargingStationId: "CH-REM-S001", EvseID: "CH*REM*E2" },
            { ChargingStationId: "CH-REM-S001", EvseID: "CH*REM*E3" },
          ],
        },
      ],
    };
    const statusFeed = {
      EVSEStatuses: [
        {
          OperatorID: "CH*REM",
          EVSEStatusRecord: [
            { EvseID: "CH*REM*E1", EVSEStatus: "AVAILABLE" },
            { EvseID: "CH*REM*E2", EVSEStatus: "CHARGING" },
            { EvseID: "CH*REM*E3", EVSEStatus: "REMOVED" },
          ],
        },
      ],
    };
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(dataFeed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const out = await parseChSfoeOicpLive(Buffer.from(JSON.stringify(statusFeed)), {
      log: noopLog,
    });
    const state = out.get(encodeURIComponent("CH-REM-S001"));
    expect(state).toBeDefined();
    // The REMOVED evse is delisted hardware — it's excluded from `total`,
    // leaving only the AVAILABLE and CHARGING evses.
    expect(state?.available).toBe(1);
    expect(state?.total).toBe(2);
    expect(state?.status).toBe("operational");
  });

  it("aggregates AVAILABLE → operational and OUTOFORDER → not-operational at the station level", async () => {
    const out = await parseChSfoeOicpLive(STATUS_FIXTURE, { log: noopLog });
    const s1 = out.get(encodeURIComponent("CH-GRN-S001"));
    const s2 = out.get(encodeURIComponent("CH-GRN-S002"));
    expect(s1?.status).toBe("operational");
    expect(s2?.status).toBe("not-operational");
    expect(typeof s1?.asOf).toBe("string");
  });

  it("drops EvseIDs with no station mapping rather than fabricating poiIds", async () => {
    const out = await parseChSfoeOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.has("CH*GRN*E999")).toBe(false);
    expect(out.has(encodeURIComponent("CH*GRN*E999"))).toBe(false);
  });

  it("returns an empty map when the data feed fetch fails", async () => {
    const failingFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", failingFetch);
    const out = await parseChSfoeOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.size).toBe(0);
  });
});

describe("mergeChSfoeLive", () => {
  // Anchor wall-clock just after the fixture asOf so the staleness gate
  // (30 min) leaves the live status intact.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:10:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base: EvChargingStation = {
    id: "swiss-sfoe:abc",
    sources: ["ch-sfoe"],
    sourceItemIds: ["swiss-sfoe:abc"],
    name: "Test",
    coordinates: [8, 47],
    status: "unknown",
    connectors: [],
  };

  it("overwrites base status when live carries a valid status", () => {
    const merged = mergeChSfoeLive(base, {
      asOf: "2026-05-23T00:00:00Z",
      status: "operational",
    });
    expect(merged.status).toBe("operational");
  });

  it("returns base unchanged when live is null", () => {
    expect(mergeChSfoeLive(base, null)).toBe(base);
  });

  it("ignores invalid live status values", () => {
    const merged = mergeChSfoeLive(base, {
      asOf: "2026-05-23T00:00:00Z",
      status: "nonsense",
    });
    expect(merged.status).toBe("unknown");
  });

  it("attaches availability and isLive when live data is fresh", () => {
    const live = { asOf: "2026-05-23T00:00:00Z", status: "operational", available: 2, total: 4 };
    const merged = mergeChSfoeLive(base, live);
    expect(merged.availability).toEqual({ available: 2, total: 4, updatedAt: live.asOf });
    expect(merged.isLive).toBe(true);
  });

  it("does not attach availability when live data is stale", () => {
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const live = { asOf: "2026-07-20T11:00:00Z", status: "operational", available: 2, total: 4 }; // 1h old > 30m
    const merged = mergeChSfoeLive(base, live);
    expect(merged.availability).toBeUndefined();
    expect(merged.isLive).toBeFalsy();
    expect(merged.status).toBe("unknown");
  });
});
