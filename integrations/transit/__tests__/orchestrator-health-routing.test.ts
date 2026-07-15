import type {
  IntegrationContext,
  ProviderHealthHandle,
  TransitProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { Departure, TripPlan } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransitOrchestrator } from "../orchestrator.js";

const ATTR: Attribution[] = [{ sourceId: "test", name: "Test" }];

function makeProvider(overrides: Partial<TransitProvider>): TransitProvider {
  return {
    id: "test-provider",
    prefix: "tp:",
    coverage: { all: true },
    priority: 5,
    attribution: ATTR,
    capabilities: {
      stops: {
        lookup: true,
        nearby: false,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehicleJourney: false,
    },
    healthCheck: async () => ({ healthy: true }),
    ...overrides,
  };
}

function makeCtx(
  providers: TransitProvider[],
  health: Pick<ProviderHealthHandle, "isHealthy">,
): IntegrationContext {
  return {
    providerHealth: {
      isHealthy: health.isHealthy,
      recordSuccess: () => Promise.resolve(),
      recordFailure: () => Promise.resolve(),
    } as ProviderHealthHandle,
    getIntegrationsByDomain: (domain: string) => {
      if (domain !== "transit") return [];
      return [{ providers: new Map([["transit", providers]]) }];
    },
  } as unknown as IntegrationContext;
}

describe("orchestrator prefix routing honours provider health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips an unhealthy provider and returns an empty result when no alternative matches", async () => {
    const departures = vi
      .fn()
      .mockResolvedValue(
        withAttribution(
          [{ tripId: "tp:trip-1" }] as Departure[],
          ATTR,
          freshnessNow({ hasRealtimeData: true }),
        ),
      );
    const provider = makeProvider({ getDepartures: departures });
    const ctx = makeCtx([provider], { isHealthy: () => Promise.resolve(false) });
    const orchestrator = createTransitOrchestrator(ctx);

    const res = await orchestrator.getDepartures("tp:stop-1", 30);

    expect(departures).not.toHaveBeenCalled();
    expect(res.data).toEqual([]);
    expect(res.freshness.hasRealtimeData).toBe(true);
  });

  it("falls through to the next healthy provider sharing the same prefix", async () => {
    const winnerDepartures = vi
      .fn()
      .mockResolvedValue(
        withAttribution(
          [{ tripId: "tp:trip-from-backup" }] as Departure[],
          ATTR,
          freshnessNow({ hasRealtimeData: true }),
        ),
      );
    const broken = makeProvider({
      id: "broken",
      prefix: "tp:",
      priority: 1,
      getDepartures: vi.fn(),
    });
    const winner = makeProvider({
      id: "winner",
      prefix: "tp:",
      priority: 2,
      getDepartures: winnerDepartures,
    });
    const isHealthy = vi.fn().mockImplementation(async (id: string) => id !== "broken");
    const ctx = makeCtx([broken, winner], { isHealthy });
    const orchestrator = createTransitOrchestrator(ctx);

    const res = await orchestrator.getDepartures("tp:stop-1", 30);

    expect(broken.getDepartures).not.toHaveBeenCalled();
    expect(winnerDepartures).toHaveBeenCalledOnce();
    expect(res.data).toEqual([{ tripId: "tp:trip-from-backup" }]);
  });

  it("uses the only matching provider when it is healthy", async () => {
    const departures = vi
      .fn()
      .mockResolvedValue(
        withAttribution(
          [{ tripId: "tp:trip-ok" }] as Departure[],
          ATTR,
          freshnessNow({ hasRealtimeData: true }),
        ),
      );
    const provider = makeProvider({ getDepartures: departures });
    const ctx = makeCtx([provider], { isHealthy: () => Promise.resolve(true) });
    const orchestrator = createTransitOrchestrator(ctx);

    const res = await orchestrator.getDepartures("tp:stop-1", 30);

    expect(departures).toHaveBeenCalledOnce();
    expect(res.data).toEqual([{ tripId: "tp:trip-ok" }]);
  });
});

describe("orchestrator hard planning capability selection", () => {
  const plan: TripPlan = {
    from: { name: "A", lat: 1, lng: 1 },
    to: { name: "B", lat: 2, lng: 2 },
    itineraries: [
      { duration: 1, startTime: "a", endTime: "b", transfers: 0, walkDistance: 0, legs: [] },
    ],
  };

  it("skips an equal-priority provider that cannot honor a hard constraint", async () => {
    const incapablePlan = vi.fn();
    const capablePlan = vi.fn().mockResolvedValue(withAttribution([plan], ATTR, freshnessNow()));
    const incapable = makeProvider({
      id: "incapable",
      capabilities: { ...makeProvider({}).capabilities, planning: true },
      planTrip: incapablePlan,
    });
    const capable = makeProvider({
      id: "capable",
      capabilities: {
        ...makeProvider({}).capabilities,
        planning: true,
        planningFeatures: {
          maxTransfers: true,
          transferBuffer: true,
          wheelchairRequired: true,
          bikeTransport: true,
          elevation: true,
          rentalFilters: true,
          detailedTransfers: true,
          paging: true,
          refresh: true,
        },
      },
      planTrip: capablePlan,
    });
    const orchestrator = createTransitOrchestrator(
      makeCtx([incapable, capable], { isHealthy: () => Promise.resolve(true) }),
    );
    const result = await orchestrator.planTrip({
      from: { lat: 1, lng: 1 },
      to: { lat: 2, lng: 2 },
      maxTransfers: 1,
    });
    expect(incapablePlan).not.toHaveBeenCalled();
    expect(capablePlan).toHaveBeenCalledOnce();
    expect(result.data).not.toBeNull();
  });

  it("rejects instead of silently dropping unsupported constraints", async () => {
    const provider = makeProvider({
      capabilities: { ...makeProvider({}).capabilities, planning: true },
      planTrip: vi.fn(),
    });
    const orchestrator = createTransitOrchestrator(
      makeCtx([provider], { isHealthy: () => Promise.resolve(true) }),
    );
    await expect(
      orchestrator.planTrip({
        from: { lat: 1, lng: 1 },
        to: { lat: 2, lng: 2 },
        wheelchairRequired: true,
      }),
    ).rejects.toMatchObject({ capabilities: ["wheelchairRequired"] });
  });
});
