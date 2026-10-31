import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { Departure, TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { createTransitSuggestionProvider } from "../index.js";
import { enrichDeparturesWithRealtime } from "../realtime.js";

const a = { sourceId: "a", name: "A" };
const b = { sourceId: "b", name: "B" };
const c = { sourceId: "c", name: "C" };

describe("transit contributor receipts", () => {
  it("preserves per-stop receipts in mixed stop suggestions", async () => {
    const stops = [a, b].map(
      (receipt, i) =>
        ({
          id: `ms:${i}`,
          name: receipt.name,
          lat: 1,
          lng: 2,
          modes: ["rail"],
          provider: "ms",
          contributors: [receipt],
        }) as TransitStop,
    );
    const provider = createTransitSuggestionProvider({
      searchByName: async () => ({ data: stops, attributions: [a, b], freshness: freshnessNow() }),
    });
    const out = await provider.searchSuggestions(
      { query: "A", lang: "en", limit: 10 },
      { signal: new AbortController().signal, deadlineAt: Infinity },
    );
    expect(out.suggestions.map((row) => row.contributors)).toEqual([[a], [b]]);
  });

  it("clones cached base and credits only applied batch deltas per row", async () => {
    const base = {
      data: ["1", "2"].map(
        (tripId) =>
          ({
            tripId,
            route: { id: "r", shortName: "1", longName: "", mode: "rail" },
            headsign: "X",
            scheduledAt: "2026-01-01T00:00:00Z",
            platform: "1",
            contributors: [a],
          }) as Departure,
      ),
      attributions: [a],
      freshness: freshnessNow(),
    };
    const rt = {
      id: "rt",
      priority: 1,
      coverage: { all: true },
      capabilities: { tripUpdates: true },
      getTripUpdates: async () => ({
        data: {
          "1": { tripId: "1", platform: "1", contributors: [b] },
          "2": { tripId: "2", platform: "2", contributors: [c] },
        },
        attributions: [b, c],
        freshness: freshnessNow(),
      }),
    } as unknown as RealtimeProvider;
    const ctx = {
      getIntegrationsByDomain: () => [{ providers: new Map([["live-transit", [rt]]]) }],
    } as unknown as IntegrationContext;
    const out = await enrichDeparturesWithRealtime(
      { ctx, timed: async (_id, _method, fn) => ({ ok: true, value: await fn() }) },
      base,
      { stopId: "s" },
    );
    expect(base.data[1].platform).toBe("1");
    expect(out.data.map((row) => row.contributors)).toEqual([[a], [a, c]]);
    expect(out.attributions).toEqual([a, c]);
  });
});

it("drops duplicate stop B receipts after real provider fan-out and capping", async () => {
  const { createTransitOrchestrator } = await import("../orchestrator.js");
  const stop = { name: "Central Station", lat: 50, lng: 8, modes: ["rail"] } as const;
  const providers = [a, b].map((receipt, i) => ({
    id: receipt.sourceId,
    prefix: `${receipt.sourceId}:`,
    priority: i,
    role: "regional",
    coverage: { all: true },
    searchStopsByName: async () => ({
      data: [{ ...stop, id: `${receipt.sourceId}:stop`, provider: receipt.sourceId }],
      attributions: [receipt],
      freshness: freshnessNow(),
    }),
  }));
  const ctx = {
    getIntegrationsByDomain: () => [{ providers: new Map([["transit", providers]]) }],
  } as unknown as IntegrationContext;
  const out = await createTransitOrchestrator(ctx).searchByName("Central", 1);
  expect(out.data.map((row) => row.contributors)).toEqual([[a]]);
  expect(out.attributions).toEqual([a]);
});

it("credits no discarded discovery candidates when linked-stop pruning is empty", async () => {
  const { createPlaceTransit } = await import("../place-transit.js");
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
  } as unknown as IntegrationContext;
  const orchestrator = {
    searchByNameRaw: async () => ({
      data: [{ id: "a:far", name: "Central", lat: 0, lng: 0, provider: "a", modes: ["rail"] }],
      attributions: [a],
      freshness: freshnessNow(),
    }),
  };
  const out = await createPlaceTransit(ctx, orchestrator as never).getLinkedStops(50, 8, "Central");
  expect(out.data).toEqual([]);
  expect(out.attributions).toEqual([]);
});
