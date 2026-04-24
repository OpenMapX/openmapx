import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@integrations/geocoding-db-ris/ris-client.js", () => ({
  isRisConfigured: vi.fn(() => true),
  risPost: vi.fn(),
  setRisCredentials: vi.fn(),
}));

async function loadDbProviderModule() {
  vi.resetModules();
  return import("@integrations/live-transit-db-ris/index.js");
}

async function loadEnturProviderModule() {
  vi.resetModules();
  return import("@integrations/live-transit-entur/index.js");
}

function createCtx(config: Record<string, unknown> = {}) {
  let provider: unknown;
  let healthCheck: (() => Promise<unknown>) | undefined;

  return {
    ctx: {
      config,
      registerProvider: (_domain: string, nextProvider: unknown) => {
        provider = nextProvider;
      },
      registerHealthCheck: (fn: () => Promise<unknown>) => {
        healthCheck = fn;
      },
    },
    getProvider: () =>
      provider as {
        getVehicles: (bbox: [number, number, number, number]) => Promise<unknown>;
        getAlerts?: (bbox: [number, number, number, number]) => Promise<unknown>;
      },
    getHealthCheck: () => healthCheck,
  };
}

describe("live-transit-db-ris provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges live and emulated RIS positions and filters to the requested bbox", async () => {
    const { risPost } = await import("@integrations/geocoding-db-ris/ris-client.js");
    vi.mocked(risPost)
      .mockResolvedValueOnce({
        positions: [
          {
            journeyID: "train-1",
            latitude: 50.11,
            longitude: 8.68,
            direction: 92,
            speed: 144,
            info: {
              transportAtStart: {
                category: "ICE",
                journeyNumber: 612,
              },
              origin: { name: "Frankfurt(Main)Hbf" },
              destination: { name: "Muenchen Hbf" },
            },
            meta: { timeCreated: "2026-04-21T20:05:00.000Z" },
          },
        ],
      })
      .mockResolvedValueOnce({
        positions: [
          {
            journeyID: "train-1",
            latitude: 50.1,
            longitude: 8.67,
            category: "ICE",
          },
          {
            journeyID: "outside",
            latitude: 52.52,
            longitude: 13.4,
            category: "RE",
          },
        ],
      });

    const mod = await loadDbProviderModule();
    const { ctx, getProvider } = createCtx({
      clientId: "client",
      apiKey: "secret",
      administrationIds: "80,81",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const vehicles = (await provider.getVehicles([8.5, 49.9, 8.9, 50.2])) as Array<
      Record<string, unknown>
    >;

    expect(vehicles).toEqual([
      expect.objectContaining({
        id: "db-ris-maps:train-1",
        provider: "db-ris-maps",
        sourceId: "db-ris-maps",
        mode: "rail",
        displayLabel: "ICE 612",
        secondaryLabel: "Frankfurt(Main)Hbf -> Muenchen Hbf",
        speed: 40,
      }),
    ]);
  });

  it("falls back to the journey id when RIS transport metadata is empty", async () => {
    const { risPost } = await import("@integrations/geocoding-db-ris/ris-client.js");
    vi.mocked(risPost)
      .mockResolvedValueOnce({
        positions: [
          {
            journeyID: "train-empty",
            latitude: 50.11,
            longitude: 8.68,
            info: {
              transportAtStart: {},
            },
            meta: { timeCreated: "2026-04-21T20:05:00.000Z" },
          },
        ],
      })
      .mockResolvedValueOnce({
        positions: [],
      });

    const mod = await loadDbProviderModule();
    const { ctx, getProvider } = createCtx({
      clientId: "client",
      apiKey: "secret",
      administrationIds: "80,81",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const vehicles = (await provider.getVehicles([8.5, 49.9, 8.9, 50.2])) as Array<
      Record<string, unknown>
    >;

    expect(vehicles).toEqual([
      expect.objectContaining({
        id: "db-ris-maps:train-empty",
        displayLabel: "train-empty",
        label: "train-empty",
      }),
    ]);
  });
});

describe("live-transit-entur provider", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps realtime vehicles and local situations into the live-transit contract", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            vehicles: [
              {
                vehicleId: "1035-2026-04-21",
                lastUpdated: "2026-04-21T20:05:19.286Z",
                bearing: 91.5,
                speed: 23.4,
                mode: "RAIL",
                line: {
                  lineRef: "VYG:Line:R14",
                  lineName: "Asker-Oslo S-Kongsvinger",
                  publicCode: "R14",
                },
                serviceJourney: {
                  id: "VYG:ServiceJourney:1035_442947-R",
                  date: "2026-04-21",
                },
                operator: {
                  name: "Vy",
                },
                location: {
                  latitude: 59.919183,
                  longitude: 10.692515,
                },
                monitoredCall: {
                  stopPointRef: "NSR:ScheduledStopPoint:1",
                  order: 6,
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            situations: [
              {
                id: "situation-1",
                summary: [{ value: "Track change", language: "en" }],
                description: [{ value: "Platform changed at Oslo S", language: "en" }],
                reportType: "stopMoved",
                severity: "severe",
                validityPeriod: {
                  startTime: "2026-04-21T19:00:00Z",
                  endTime: "2026-04-21T22:00:00Z",
                },
                lines: [{ id: "VYG:Line:R14" }],
                stopPlaces: [
                  {
                    id: "NSR:StopPlace:337",
                    latitude: 59.910925,
                    longitude: 10.753276,
                  },
                ],
                quays: [],
              },
            ],
          },
        }),
      } as Response);

    const mod = await loadEnturProviderModule();
    const { ctx, getProvider } = createCtx({
      clientName: "openmapx-tests",
      journeyPlannerEndpoint: "https://api.entur.io/journey-planner/v3/graphql",
      vehiclesEndpoint: "https://api.entur.io/realtime/v2/vehicles/graphql",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const vehicles = (await provider.getVehicles([10.6, 59.8, 10.8, 60.0])) as Array<
      Record<string, unknown>
    >;
    const alerts = (await provider.getAlerts?.([10.7, 59.9, 10.8, 59.95])) as Array<
      Record<string, unknown>
    >;

    expect(vehicles).toEqual([
      expect.objectContaining({
        id: "entur-live-vehicles:1035-2026-04-21",
        provider: "entur-live-vehicles",
        sourceId: "entur-live-vehicles",
        mode: "rail",
        displayLabel: "R14",
        secondaryLabel: "Asker-Oslo S-Kongsvinger",
        codespaceId: "VYG",
        routeId: "entur:VYG:Line:R14",
        tripId: "entur:2026-04-21|VYG:ServiceJourney:1035_442947-R",
      }),
    ]);

    expect(alerts).toEqual([
      expect.objectContaining({
        id: "entur:situation-1",
        severity: "severe",
        title: "Track change",
        affectedRouteIds: ["entur:VYG:Line:R14"],
        affectedStopIds: ["entur:NSR:StopPlace:337"],
      }),
    ]);
  });
});
