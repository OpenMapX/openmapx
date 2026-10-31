import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createTransitOrchestrator } from "../orchestrator.js";

const ATTR: Attribution[] = [{ sourceId: "test", name: "Test" }];

function stop(provider: string): TransitStop {
  return { id: `${provider}:central`, provider, name: "Central", lat: 50, lng: 7, modes: [] };
}

function searching(
  id: string,
  search: TransitProvider["searchStopsByName"],
  sourceId = `${id}-source`,
): { provider: TransitProvider; sourceId: string } {
  return {
    sourceId,
    provider: {
      id,
      prefix: `${id}:`,
      coverage: { all: true },
      priority: 5,
      role: "regional",
      attribution: ATTR,
      capabilities: {
        stops: {
          lookup: false,
          nearby: false,
          bbox: false,
          search: true,
          infrastructure: false,
          platforms: false,
          timetable: false,
        },
        departures: false,
        arrivals: false,
        routes: { lookup: false, forStop: false, stops: false, geometry: false },
        planning: false,
        vehicleJourney: false,
      },
      healthCheck: async () => ({ healthy: true }),
      searchStopsByName: search,
    },
  };
}

function answering(id: string) {
  return searching(
    id,
    vi.fn(async () => withAttribution([stop(id)], ATTR, freshnessNow())),
  );
}

function failing(id: string) {
  return searching(
    id,
    vi.fn(async () => {
      throw new Error("upstream down");
    }),
  );
}

function orchestrator(
  entries: { provider: TransitProvider; sourceId: string }[],
  options: { coolingDown?: string[]; disallowedSources?: string[] } = {},
) {
  const recordFailure = vi.fn(async () => {});
  const ctx = {
    providerHealth: {
      isHealthy: async (id: string) => !options.coolingDown?.includes(id),
      recordSuccess: async () => {},
      recordFailure,
    },
    getDisallowedSourceIds: async () => new Set(options.disallowedSources ?? []),
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit"
        ? entries.map(({ provider, sourceId }) => ({
            manifest: { dataSources: [{ sourceId }] },
            providers: new Map([["transit", [provider]]]),
          }))
        : [],
  } as unknown as IntegrationContext;
  return { transit: createTransitOrchestrator(ctx), recordFailure };
}

describe("stop-name search coverage", () => {
  it("keeps answers from working providers and marks the result partial when one fails", async () => {
    const { transit, recordFailure } = orchestrator([answering("a"), failing("b")]);

    const result = await transit.searchByNameRaw("Central", 30);

    expect(result.data.map((s) => s.id)).toEqual(["a:central"]);
    expect(result.freshness.isPartial).toBe(true);
    expect(recordFailure).toHaveBeenCalledWith(
      "b",
      expect.any(Number),
      "connection",
      "upstream down",
    );
  });

  it("counts a provider in health cooldown as a gap without calling it", async () => {
    const cooling = answering("b");
    const { transit } = orchestrator([answering("a"), cooling], { coolingDown: ["b"] });

    const result = await transit.searchByNameRaw("Central", 30);

    expect(result.data.map((s) => s.id)).toEqual(["a:central"]);
    expect(result.freshness.isPartial).toBe(true);
    expect(cooling.provider.searchStopsByName).not.toHaveBeenCalled();
  });

  it.each([
    ["every provider fails", [failing("a"), failing("b")], {}],
    ["the only provider is in cooldown", [answering("a")], { coolingDown: ["a"] }],
  ])("rejects when %s instead of answering with no stops", async (_case, entries, options) => {
    const { transit } = orchestrator(entries, options);

    await expect(transit.searchByNameRaw("Central", 30)).rejects.toThrow(
      "Transit stop sources unavailable",
    );
    await expect(transit.searchByName("Central", 5)).rejects.toThrow(
      "Transit stop sources unavailable",
    );
  });

  it("treats a provider excluded by the data-use policy as intended, not as a gap", async () => {
    const excluded = failing("b");
    const { transit } = orchestrator([answering("a"), excluded], {
      disallowedSources: [excluded.sourceId],
    });

    const result = await transit.searchByNameRaw("Central", 30);

    expect(result.data.map((s) => s.id)).toEqual(["a:central"]);
    expect(result.freshness.isPartial).toBeUndefined();
    expect(excluded.provider.searchStopsByName).not.toHaveBeenCalled();
  });

  it("answers a complete empty result when providers find nothing or none is eligible", async () => {
    const empty = searching(
      "a",
      vi.fn(async () => withAttribution([], ATTR, freshnessNow())),
    );
    for (const entries of [[empty], []]) {
      const result = await orchestrator(entries).transit.searchByNameRaw("Nowhere", 30);
      expect(result.data).toEqual([]);
      expect(result.freshness.isPartial).toBeUndefined();
    }
  });

  it("passes partial coverage through the deduplicated search", async () => {
    const { transit } = orchestrator([answering("a"), failing("b")]);

    const result = await transit.searchByName("Central", 5);

    expect(result.data).toHaveLength(1);
    expect(result.freshness.isPartial).toBe(true);
  });

  it("reports caller cancellation as cancellation, not as a provider outage", async () => {
    const controller = new AbortController();
    const slow = searching(
      "a",
      vi.fn(async () => {
        controller.abort(new Error("caller left"));
        throw new Error("aborted upstream");
      }),
    );
    const { transit } = orchestrator([slow]);

    await expect(
      transit.searchByNameRaw("Central", 30, undefined, {
        signal: controller.signal,
        deadlineAt: Date.now() + 1_000,
      }),
    ).rejects.toThrow("caller left");
  });
});
