import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSwissOicpLive } from "../switzerland-live-parser.js";
import { mergeSwitzerlandLive } from "../switzerland-mapper.js";

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

describe("parseSwissOicpLive", () => {
  beforeEach(() => {
    installDataFeedFetchStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces one PoiLiveState per station keyed by encoded ChargingStationId", async () => {
    const out = await parseSwissOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.size).toBe(2);
    expect(out.has(encodeURIComponent("CH-GRN-S001"))).toBe(true);
    expect(out.has(encodeURIComponent("CH-GRN-S002"))).toBe(true);
  });

  it("aggregates AVAILABLE → operational and OUTOFORDER → not-operational at the station level", async () => {
    const out = await parseSwissOicpLive(STATUS_FIXTURE, { log: noopLog });
    const s1 = out.get(encodeURIComponent("CH-GRN-S001"));
    const s2 = out.get(encodeURIComponent("CH-GRN-S002"));
    expect(s1?.status).toBe("operational");
    expect(s2?.status).toBe("not-operational");
    expect(typeof s1?.asOf).toBe("string");
  });

  it("drops EvseIDs with no station mapping rather than fabricating poiIds", async () => {
    const out = await parseSwissOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.has("CH*GRN*E999")).toBe(false);
    expect(out.has(encodeURIComponent("CH*GRN*E999"))).toBe(false);
  });

  it("returns an empty map when the data feed fetch fails", async () => {
    const failingFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", failingFetch);
    const out = await parseSwissOicpLive(STATUS_FIXTURE, { log: noopLog });
    expect(out.size).toBe(0);
  });
});

describe("mergeSwitzerlandLive", () => {
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
    sources: ["switzerland-ev"],
    sourceItemIds: ["swiss-sfoe:abc"],
    name: "Test",
    coordinates: [8, 47],
    status: "unknown",
    connectors: [],
  };

  it("overwrites base status when live carries a valid status", () => {
    const merged = mergeSwitzerlandLive(base, {
      asOf: "2026-05-23T00:00:00Z",
      status: "operational",
    });
    expect(merged.status).toBe("operational");
  });

  it("returns base unchanged when live is null", () => {
    expect(mergeSwitzerlandLive(base, null)).toBe(base);
  });

  it("ignores invalid live status values", () => {
    const merged = mergeSwitzerlandLive(base, {
      asOf: "2026-05-23T00:00:00Z",
      status: "nonsense",
    });
    expect(merged.status).toBe("unknown");
  });
});
