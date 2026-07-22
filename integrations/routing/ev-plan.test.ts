import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { type ResolvedRoutingProvider, runEvPlan } from "./ev-plan.js";

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const baseRoute = {
    distance: 300_000,
    duration: 12_000,
    geometry: Array.from({ length: 7 }, (_, i) => [i * 0.45, 50]),
    legs: [],
    steps: [],
    mode: "driving",
    elevation: undefined,
  };
  const valhalla = {
    id: "valhalla",
    // getRoute returns a DirectionsResult (routes[] + activeRouteIndex), NOT a bare Route.
    getRoute: vi
      .fn()
      .mockResolvedValue({ routes: [baseRoute], activeRouteIndex: 0, waypoints: [] }),
    getMatrix: vi
      .fn()
      .mockImplementation(async (s: unknown[], t: unknown[]) =>
        s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
      ),
  };
  const evProvider = {
    searchStations: vi.fn().mockResolvedValue([
      {
        id: "c1",
        name: "c1",
        coordinates: [1.35, 50],
        sources: ["ocm"],
        connectors: [{ type: "CCS", powerKw: 150, currentType: "dc" }],
        attributions: [{ sourceId: "ocm", name: "OpenChargeMap" }],
      },
    ]),
  };
  return {
    log: { warn: vi.fn(), error: vi.fn() },
    cache: { withCache: (_k: string, _t: number, fn: () => unknown) => fn() },
    // LoadedIntegration shape: { id, providers: Map<domain, unknown[]> }
    getIntegrationsByDomain: (d: string) =>
      d === "data-source"
        ? [{ id: "ev-charging", providers: new Map([["data-source", [evProvider]]]) }]
        : [],
    getDisallowedSourceIds: async () => new Set<string>(),
    ...overrides,
    _valhalla: valhalla,
    _evProvider: evProvider,
  };
}

describe("runEvPlan", () => {
  it("produces a route with a charging stop and threads closures into both routing calls", async () => {
    const ctx = fakeCtx();
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 80,
      ambientTempC: 20,
      avoidClosures: false,
    });
    expect(result.stops.length).toBeGreaterThanOrEqual(1);
    expect(result.stops[0].attributions[0].sourceId).toBe("ocm");
    // getRoute called twice: base + re-route with inserted waypoint
    expect(ctx._valhalla.getRoute).toHaveBeenCalledTimes(2);
    const rerouteWps = ctx._valhalla.getRoute.mock.calls[1][0];
    expect(rerouteWps.length).toBe(3); // origin + charger + dest
    // both routing calls receive IDENTICAL routing options (D7: avoid flags +
    // closure exclusions threaded the same way into base route and re-route).
    expect(ctx._valhalla.getRoute.mock.calls[1][2]).toEqual(
      ctx._valhalla.getRoute.mock.calls[0][2],
    );
  });

  it("threads real closure exclusions into both routing calls", async () => {
    // Route runs along lat=50 from lng 0 to lng 2.7 (same fixture geometry as
    // the other tests). Put an active road_closure right on the corridor so
    // activeClosuresForBbox (integrations/routing/closures.ts) surfaces it as
    // a Valhalla exclusion point. Fixture shape mirrors
    // integrations/routing/__tests__/avoidClosures.test.ts's closureEvents.
    const closurePoint: [number, number] = [1.35, 50];
    const closureEvents = [
      {
        id: "closure:0",
        source: "test",
        provider: "road-conditions-stub",
        type: "road_closure",
        severity: "high",
        geometry: { type: "Point", coordinates: closurePoint },
        headline: "Closure 0",
      },
    ];

    const ctx = fakeCtx({
      getIntegrationsByDomain: (d: string) => {
        if (d === "data-source") {
          return [
            {
              id: "ev-charging",
              providers: new Map([["data-source", [ctxEvProvider()]]]),
            },
          ];
        }
        if (d === "road-conditions") {
          return [
            {
              id: "road-conditions-stub",
              providers: new Map<string, unknown[]>([
                [
                  "road-conditions",
                  [
                    {
                      id: "road-conditions-stub",
                      getEvents: vi.fn().mockResolvedValue(closureEvents),
                    },
                  ],
                ],
              ]),
            },
          ];
        }
        return [];
      },
    });

    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 80,
      ambientTempC: 20,
      avoidClosures: true,
    });

    expect(result.stops.length).toBeGreaterThanOrEqual(1);
    expect(ctx._valhalla.getRoute).toHaveBeenCalledTimes(2);
    const baseOpts = ctx._valhalla.getRoute.mock.calls[0][2];
    const rerouteOpts = ctx._valhalla.getRoute.mock.calls[1][2];
    expect(baseOpts.excludeLocations).toEqual([closurePoint]);
    expect(baseOpts.excludeLocations.length).toBeGreaterThan(0);
    // Same exclusions threaded into BOTH the base route and the re-route (D7).
    expect(rerouteOpts).toEqual(baseOpts);
  });

  it("falls back to a great-circle matrix when getMatrix throws", async () => {
    const ctx = fakeCtx();
    ctx._valhalla.getMatrix = vi.fn().mockRejectedValue(new Error("matrix 404"));
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 80,
      ambientTempC: 20,
      avoidClosures: false,
    });
    // still produces a plan (or a clean warning) rather than throwing
    expect(result.warnings.length + result.stops.length).toBeGreaterThan(0);
  });

  it("reports a whole-trip cost estimate when a home price is given (D11)", async () => {
    const ctx = fakeCtx(); // fixture charger has no tariff → all energy valued at home price
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 80,
      ambientTempC: 20,
      avoidClosures: false,
      homePricePerKwh: 0.3,
      homeCurrency: "EUR",
    });
    expect(result.totals.estimatedCost?.currency).toBe("EUR");
    expect(result.totals.estimatedCost?.amount).toBeGreaterThan(0);
    expect(result.totals.estimatedCost?.homeKwh).toBeGreaterThan(0);
  });

  it("omits trip cost when no home price is given", async () => {
    const ctx = fakeCtx();
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      ambientTempC: 20,
      avoidClosures: false,
    });
    expect(result.totals.estimatedCost).toBeUndefined();
    expect(result.totals.energyKwh).toBeGreaterThan(0); // energy still shown
  });

  it("reports a per-currency breakdown when a public stop is priced in a foreign currency", async () => {
    const ctx = fakeCtx({
      getIntegrationsByDomain: (d: string) =>
        d === "data-source"
          ? [
              {
                id: "ev-charging",
                providers: new Map([
                  [
                    "data-source",
                    [
                      {
                        searchStations: vi.fn().mockResolvedValue([
                          {
                            id: "c1",
                            name: "c1",
                            coordinates: [1.35, 50],
                            sources: ["ocm"],
                            connectors: [{ type: "CCS", powerKw: 150, currentType: "dc" }],
                            attributions: [{ sourceId: "ocm", name: "OpenChargeMap" }],
                            tariffs: [
                              {
                                scope: "cpo",
                                elements: [{ type: "energy", price: 0.55, currency: "CHF" }],
                                source: "test",
                                updatedAt: new Date().toISOString(),
                              },
                            ],
                          },
                        ]),
                      },
                    ],
                  ],
                ]),
              },
            ]
          : [],
    });
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 50,
      ambientTempC: 20,
      avoidClosures: false,
      homePricePerKwh: 0.3,
      homeCurrency: "EUR",
    });
    expect(result.stops.length).toBeGreaterThanOrEqual(1);
    expect(result.stops[0].estimatedCost?.currency).toBe("CHF");
    expect(result.totals.estimatedCost?.currency).toBe("EUR");
    expect(result.totals.estimatedCost?.amount).toBeGreaterThan(0);
    expect(result.totals.estimatedCost?.otherCurrencies).toContainEqual(
      expect.objectContaining({ currency: "CHF", amount: expect.any(Number) }),
    );
    expect(result.totals.estimatedCost?.otherCurrencies?.[0]?.amount).toBeGreaterThan(0);
  });

  it("flags tight-margin when the final route arrives with barely enough charge, and not when it's comfortable", async () => {
    const lowTargetCtx = fakeCtx();
    const getProvidersLow = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: lowTargetCtx._valhalla },
    ];
    const lowResult = await runEvPlan(
      lowTargetCtx as unknown as IntegrationContext,
      getProvidersLow,
      {
        waypoints: [
          [0, 50],
          [2.7, 50],
        ],
        vehicleId: "tesla:model_3:2024:model_3_long_range",
        socStartPct: 40,
        socArrivalMinPct: 10,
        socTargetPct: 25,
        ambientTempC: 20,
        avoidClosures: false,
      },
    );
    expect(lowResult.warnings.some((w) => w.kind === "tight-margin")).toBe(true);
    expect(lowResult.warnings.some((w) => w.kind === "unreachable")).toBe(false);

    const highTargetCtx = fakeCtx();
    const getProvidersHigh = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: highTargetCtx._valhalla },
    ];
    const highResult = await runEvPlan(
      highTargetCtx as unknown as IntegrationContext,
      getProvidersHigh,
      {
        waypoints: [
          [0, 50],
          [2.7, 50],
        ],
        vehicleId: "tesla:model_3:2024:model_3_long_range",
        socStartPct: 40,
        socArrivalMinPct: 10,
        socTargetPct: 80,
        ambientTempC: 20,
        avoidClosures: false,
      },
    );
    expect(highResult.warnings.some((w) => w.kind === "tight-margin")).toBe(false);
    expect(highResult.warnings.some((w) => w.kind === "unreachable")).toBe(false);
  });

  it("skips disallowed charger sources", async () => {
    const ctx = fakeCtx({ getDisallowedSourceIds: async () => new Set(["ocm"]) });
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const result = await runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      socArrivalMinPct: 10,
      socTargetPct: 80,
      ambientTempC: 20,
      avoidClosures: false,
    });
    expect(
      result.warnings.some((w) => w.kind === "no-charger-data" || w.kind === "unreachable"),
    ).toBe(true);
  });
});

/** Fresh ev-charging data-source stub, shared shape with `fakeCtx`'s default. */
function ctxEvProvider() {
  return {
    searchStations: vi.fn().mockResolvedValue([
      {
        id: "c1",
        name: "c1",
        coordinates: [1.35, 50],
        sources: ["ocm"],
        connectors: [{ type: "CCS", powerKw: 150, currentType: "dc" }],
        attributions: [{ sourceId: "ocm", name: "OpenChargeMap" }],
      },
    ]),
  };
}
