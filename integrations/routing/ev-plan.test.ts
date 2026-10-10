import {
  type ChargingSiteProvider,
  type ChargingSiteQuery,
  createSiteOrchestrator,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import type { ChargingSite, EnergyTariff } from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it, vi } from "vitest";
import { roadConditionEvent } from "./__tests__/support/road-condition.js";
import { type ResolvedRoutingProvider, runEvPlan } from "./ev-plan.js";

const SITE_ID = "oc:feature:nl-ndw-charging:NL-ABC-1";

/** One CCS site mid-route, with one fresh free charge point. */
function chargingSite(over: Partial<ChargingSite> = {}): ChargingSite {
  return {
    id: SITE_ID,
    name: "c1",
    coordinates: [1.35, 50],
    payment: [],
    authentication: [],
    closed: false,
    planned: false,
    evses: [
      {
        key: "e1",
        quantity: 1,
        status: "available",
        statusAt: "2026-10-05T08:00:00Z",
        stale: false,
        capabilities: [],
        parkingRestrictions: [],
        connectors: [
          {
            key: "e1/1",
            standard: "IEC_62196_T2_COMBO",
            current: "dc",
            maxPowerKw: 150,
            tariffIds: [],
            stale: false,
          },
        ],
      },
    ],
    tariffs: [],
    sources: ["ocm-charging"],
    attributions: [{ sourceId: "ocm-charging", name: "Open Charge Map" }],
    ...over,
  };
}

const energyTariff = (id: string, price: number, currency = "EUR"): EnergyTariff => ({
  id,
  currency,
  elements: [{ components: [{ type: "energy", price }] }],
  priceIncludesVat: true,
  sourceId: "nl-ndw-charging",
});

/** A `charging-sites` provider answering every window with these sites. */
function sitesProvider(sites: ChargingSite[] = [chargingSite()], partial?: "area" | "unavailable") {
  return {
    id: "openconditions",
    searchSites: vi.fn().mockResolvedValue(partial ? { sites, partial } : { sites }),
    getSite: vi.fn().mockResolvedValue(null),
  };
}

const chargingDomain = (provider: ReturnType<typeof sitesProvider>) => (d: string) =>
  d === "charging-sites"
    ? [{ id: "openconditions", providers: new Map([["charging-sites", [provider]]]) }]
    : [];

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const cache = { withCache: vi.fn((_k: string, _t: number, fn: () => unknown) => fn()) };
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
    supportsExclusions: true,
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
  const evProvider = sitesProvider();
  return {
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    cache,
    // LoadedIntegration shape: { id, providers: Map<domain, unknown[]> }
    getIntegrationsByDomain: chargingDomain(evProvider),
    getDisallowedSourceIds: async () => new Set<string>(),
    ...overrides,
    _valhalla: valhalla,
    _evProvider: evProvider,
    _cache: cache,
  };
}

describe("runEvPlan", () => {
  it("does not cache or claim current road-condition protection without engine proof", async () => {
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
      socStartPct: 80,
      avoidClosures: false,
    });

    expect(ctx._cache.withCache).not.toHaveBeenCalled();
    expect(result.roadConditionImpact).toMatchObject({
      availability: "unsupported",
      evaluatedAt: expect.any(String),
      validUntil: null,
      reasons: expect.arrayContaining(["unverified_engine_application", "ev_matrix_unprotected"]),
    });
  });

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
    expect(result.stops[0].station.id).toBe(SITE_ID);
    expect(result.stops[0].attributions).toEqual([{ text: "Open Charge Map", url: "" }]);
    expect(result.stops[0].availability).toEqual({
      available: 1,
      total: 1,
      updatedAt: "2026-10-05T08:00:00Z",
    });
    // getRoute called twice: base + re-route with inserted waypoint
    expect(ctx._valhalla.getRoute).toHaveBeenCalledTimes(2);
    const rerouteWps = ctx._valhalla.getRoute.mock.calls[1][0];
    expect(rerouteWps.length).toBe(3); // origin + charger + dest
    // both routing calls receive IDENTICAL routing options (avoid flags +
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
      roadConditionEvent({
        id: "closure:0",
        provider: "road-conditions-stub",
        geometry: { type: "Point", coordinates: closurePoint },
      }),
    ];

    const ctx = fakeCtx({
      getIntegrationsByDomain: (d: string) => {
        if (d === "charging-sites") return chargingDomain(sitesProvider())(d);
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
    // Same exclusions threaded into BOTH the base route and the re-route.
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

  it("omits trip cost when a planned stop has no tariff, even with a home price", async () => {
    // Most German chargers (BNetzA/OSM) publish no tariff. Billing that energy
    // at the home rate would both understate the trip and claim an impossible
    // amount was charged at home, so no cost may be reported at all.
    const ctx = fakeCtx(); // fixture charger carries no tariff
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
    expect(result.stops.length).toBeGreaterThan(0);
    expect(result.stops.every((s) => !s.estimatedCost)).toBe(true);
    expect(result.totals.estimatedCost).toBeUndefined();
    expect(result.totals.energyKwh).toBeGreaterThan(0); // energy is still reported
  });

  it("reports a whole-trip cost estimate when every stop is priced", async () => {
    const ctx = fakeCtx({
      getIntegrationsByDomain: chargingDomain(
        sitesProvider([chargingSite({ tariffs: [energyTariff("t", 0.55)] })]),
      ),
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
      avoidClosures: false,
      homePricePerKwh: 0.3,
      homeCurrency: "EUR",
    });
    expect(result.stops.every((s) => s.estimatedCost)).toBe(true);
    expect(result.totals.estimatedCost?.currency).toBe("EUR");
    expect(result.totals.estimatedCost?.amount).toBeGreaterThan(0);
    // Public energy is now actually attributed to the public stops.
    expect(result.totals.estimatedCost?.publicKwh).toBeGreaterThan(0);
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
      getIntegrationsByDomain: chargingDomain(
        sitesProvider([chargingSite({ tariffs: [energyTariff("t", 0.55, "CHF")] })]),
      ),
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

  it("does not call a route tight merely because the arrival reserve is high", async () => {
    // A bigger reserve plans MORE charging, so it must not be the thing that
    // triggers the warning: the band above the reserve is a fixed slice of the
    // pack, not a fraction of the reserve itself.
    const plan = async (socArrivalMinPct: number) => {
      const ctx = fakeCtx();
      const getProviders = (): ResolvedRoutingProvider[] => [
        { integrationId: "valhalla", provider: ctx._valhalla },
      ];
      return runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
        waypoints: [
          [0, 50],
          [2.7, 50],
        ],
        vehicleId: "tesla:model_3:2024:model_3_long_range",
        socStartPct: 80,
        socArrivalMinPct,
        socTargetPct: 80,
        ambientTempC: 20,
        avoidClosures: false,
      });
    };

    const cautious = await plan(40);
    const relaxed = await plan(10);
    expect(cautious.warnings.some((w) => w.kind === "unreachable")).toBe(false);
    expect(relaxed.warnings.some((w) => w.kind === "unreachable")).toBe(false);
    // The cautious plan charges at least as much, so it cannot be the tighter one.
    expect(cautious.totals.chargeSeconds).toBeGreaterThanOrEqual(relaxed.totals.chargeSeconds);
    const tight = (r: typeof cautious) => r.warnings.some((w) => w.kind === "tight-margin");
    expect(tight(cautious)).toBe(tight(relaxed));
  });

  it("the planner reads charging-sites providers and passes disallowed sources down", async () => {
    // The provider ignores the hint and still returns the disallowed site: the
    // planner must not plan through it.
    const provider = sitesProvider();
    const ctx = fakeCtx({
      getIntegrationsByDomain: chargingDomain(provider),
      getDisallowedSourceIds: async () => new Set(["ocm-charging"]),
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
      avoidClosures: false,
    });
    expect(provider.searchSites).toHaveBeenCalled();
    const [bbox, query] = provider.searchSites.mock.calls[0];
    expect(bbox).toHaveLength(4);
    expect(query).toEqual({ excludedSourceIds: ["ocm-charging"], maxSites: 8000 });
    expect(result.stops).toHaveLength(0);
    expect(result.warnings.some((w) => w.kind === "no-charger-data")).toBe(true);
  });

  it("without a charging provider the plan warns and has no stops", async () => {
    const ctx = fakeCtx({ getIntegrationsByDomain: () => [] });
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
      avoidClosures: false,
    });
    expect(result.stops).toHaveLength(0);
    expect(result.warnings.some((w) => w.kind === "no-charger-data")).toBe(true);
    // Only the base route was requested: there is nothing to re-route through.
    expect(ctx._valhalla.getRoute).toHaveBeenCalledTimes(1);
  });

  it("a window no charger source answered is not reported as having no chargers", async () => {
    const provider = sitesProvider([]);
    provider.searchSites.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const ctx = fakeCtx({ getIntegrationsByDomain: chargingDomain(provider) });
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
      avoidClosures: false,
    });
    expect(result.stops).toHaveLength(0);
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "charger-sources-unavailable",
      "unreachable",
      "partial-charger-data",
    ]);
  });

  it("an empty area answer beside a failed source is not reported as having no chargers", async () => {
    const wide = { ...sitesProvider([], "area"), id: "wide" };
    const down = { ...sitesProvider([]), id: "down" };
    down.searchSites.mockRejectedValue(new Error("down"));
    const ctx = fakeCtx({
      getIntegrationsByDomain: (d: string) =>
        d === "charging-sites"
          ? [{ id: "openconditions", providers: new Map([["charging-sites", [wide, down]]]) }]
          : [],
    });
    // The merged answer reads `area`, not `unavailable`: the failure is not visible in it.
    const merged = await createSiteOrchestrator<
      ChargingSiteProvider,
      ChargingSite,
      ChargingSiteQuery
    >(ctx as unknown as IntegrationContext, {
      domain: "charging-sites",
      logPrefix: "test",
      search: { name: "searchSites", run: (p, bbox, query) => p.searchSites(bbox, query) },
      get: { name: "getSite", run: (p, id, query) => p.getSite(id, query) },
    }).search([0, 49.9, 0.1, 50.1]);
    expect(merged).toEqual({ sites: [], partial: "area" });

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
      avoidClosures: false,
    });
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "charger-sources-unavailable",
      "unreachable",
      "partial-charger-data",
    ]);
  });

  it("a stop credits its sources as the place card does, with only http(s) links", async () => {
    const site = chargingSite({
      attributions: [
        {
          sourceId: "nl-ndw-charging",
          name: "NDW",
          url: "javascript:alert(1)",
          spdxLicense: "CC0-1.0",
          licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        },
      ],
    });
    const ctx = fakeCtx({ getIntegrationsByDomain: chargingDomain(sitesProvider([site])) });
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
      avoidClosures: false,
    });
    expect(result.stops[0]?.attributions).toEqual([
      {
        text: "NDW",
        url: "",
        license: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
    ]);
  });

  it("a stop's estimated cost is rounded to cents", async () => {
    const site = chargingSite({ tariffs: [energyTariff("odd", 0.3917)] });
    const ctx = fakeCtx({ getIntegrationsByDomain: chargingDomain(sitesProvider([site])) });
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
      avoidClosures: false,
    });
    const amounts = result.stops.map((s) => s.estimatedCost?.amount ?? Number.NaN);
    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) expect(amount).toBe(Math.round(amount * 100) / 100);
  });

  it("logs a failing charger provider once across plans, not once per plan", async () => {
    const provider = sitesProvider([]);
    provider.searchSites.mockRejectedValue(new Error("down"));
    const ctx = fakeCtx({ getIntegrationsByDomain: chargingDomain(provider) });
    const getProviders = (): ResolvedRoutingProvider[] => [
      { integrationId: "valhalla", provider: ctx._valhalla },
    ];
    const args = {
      waypoints: [
        [0, 50],
        [2.7, 50],
      ] as [number, number][],
      vehicleId: "tesla:model_3:2024:model_3_long_range",
      socStartPct: 40,
      avoidClosures: false,
    };
    await runEvPlan(ctx as unknown as IntegrationContext, getProviders, args);
    await runEvPlan(ctx as unknown as IntegrationContext, getProviders, args);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
  });

  it("plans on a partial answer and says so", async () => {
    const ctx = fakeCtx({
      getIntegrationsByDomain: chargingDomain(sitesProvider([chargingSite()], "unavailable")),
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
      avoidClosures: false,
    });
    expect(result.stops.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.filter((w) => w.kind === "partial-charger-data")).toHaveLength(1);
  });

  it("the card's tariff summary is the costed tariff, not the first", async () => {
    const site = chargingSite({
      tariffs: [energyTariff("dear", 0.79), energyTariff("cheap", 0.39)],
    });
    const ctx = fakeCtx({ getIntegrationsByDomain: chargingDomain(sitesProvider([site])) });
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
      avoidClosures: false,
    });
    expect(result.stops[0].tariffPrice).toEqual({ amount: 0.39, currency: "EUR", unit: "kWh" });
    expect(result.stops[0].estimatedCost).toEqual({
      amount: expect.any(Number),
      currency: "EUR",
    });
  });

  it("departAt sets the arrival time the tariffs are matched at", async () => {
    const night: EnergyTariff = {
      id: "t",
      currency: "EUR",
      elements: [
        {
          components: [{ type: "energy", price: 0.29 }],
          restrictions: { startTime: "18:00", endTime: "06:00" },
        },
        { components: [{ type: "energy", price: 0.59 }] },
      ],
      priceIncludesVat: true,
      sourceId: "nl-ndw-charging",
    };
    const plan = async (departAt: string) => {
      const ctx = fakeCtx({
        getIntegrationsByDomain: chargingDomain(
          sitesProvider([chargingSite({ tariffs: [night] })]),
        ),
      });
      const getProviders = (): ResolvedRoutingProvider[] => [
        { integrationId: "valhalla", provider: ctx._valhalla },
      ];
      return runEvPlan(ctx as unknown as IntegrationContext, getProviders, {
        waypoints: [
          [0, 50],
          [2.7, 50],
        ],
        vehicleId: "tesla:model_3:2024:model_3_long_range",
        socStartPct: 40,
        departAt,
        avoidClosures: false,
      });
    };
    expect((await plan("2026-10-05T20:00")).stops[0].tariffPrice?.amount).toBe(0.29);
    expect((await plan("2026-10-05T08:00")).stops[0].tariffPrice?.amount).toBe(0.59);
  });
});
