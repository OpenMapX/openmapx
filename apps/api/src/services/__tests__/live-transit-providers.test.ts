import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamedJsonResponse } from "../../test/streamed-response.js";

const { risPost } = vi.hoisted(() => ({ risPost: vi.fn() }));
vi.mock("@openmapx/mobility-core/ris-client", () => ({
  createRisClient: () => ({ isConfigured: () => true, post: risPost }),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

function loadManifest(integrationId: string): { dataSources: unknown[] } {
  const path = resolve(REPO_ROOT, "integrations", integrationId, "manifest.json");
  return JSON.parse(readFileSync(path, "utf-8")) as { dataSources: unknown[] };
}

async function loadDbProviderModule() {
  vi.resetModules();
  return import("@integrations/live-transit-db-ris/index.js");
}

async function loadEnturProviderModule() {
  vi.resetModules();
  return import("@integrations/live-transit-entur/index.js");
}

interface MobilityResultLike<T> {
  data: T;
  attributions: Array<{ sourceId: string }>;
  freshness: { fetchedAt: string; hasRealtimeData: boolean; isStale: boolean };
}

function createCtx(integrationId: string, config: Record<string, unknown> = {}) {
  let provider: unknown;
  let healthCheck: (() => Promise<unknown>) | undefined;

  return {
    ctx: {
      config,
      manifest: loadManifest(integrationId),
      onActivate: (activate: () => void) => activate(),
      registerRealtimeProvider: (nextProvider: unknown) => {
        provider = nextProvider;
      },
      registerHealthCheck: (fn: () => Promise<unknown>) => {
        healthCheck = fn;
      },
    },
    getProvider: () =>
      provider as {
        getVehiclePositions: (
          bbox: [number, number, number, number],
        ) => Promise<MobilityResultLike<unknown[]>>;
        getAlertsForBbox?: (
          bbox: [number, number, number, number],
        ) => Promise<MobilityResultLike<unknown[]>>;
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
    risPost
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
    const { ctx, getProvider } = createCtx("live-transit-db-ris", {
      clientId: "client",
      apiKey: "secret",
      administrationIds: "80,81",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const result = await provider.getVehiclePositions([8.5, 49.9, 8.9, 50.2]);
    const vehicles = result.data as Array<Record<string, unknown>>;

    expect(vehicles).toEqual([
      expect.objectContaining({
        id: "db-ris-maps:train-1",
        provider: "db-ris-maps",
        sourceId: "db-ris-maps",
        mode: "rail",
        displayLabel: "ICE 612",
        secondaryLabel: "Frankfurt(Main)Hbf -> Muenchen Hbf",
        positionKind: "observed",
        speed: 40,
      }),
    ]);
    expect(result.attributions.map((a) => a.sourceId)).toContain("db-ris-maps");
    expect(result.freshness.hasRealtimeData).toBe(true);
  });

  it("falls back to the journey id when RIS transport metadata is empty", async () => {
    risPost
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
    const { ctx, getProvider } = createCtx("live-transit-db-ris", {
      clientId: "client",
      apiKey: "secret",
      administrationIds: "80,81",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const result = await provider.getVehiclePositions([8.5, 49.9, 8.9, 50.2]);
    const vehicles = result.data as Array<Record<string, unknown>>;

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
      .mockResolvedValueOnce(
        streamedJsonResponse({
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
      )
      .mockResolvedValueOnce(
        streamedJsonResponse({
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
      );

    const mod = await loadEnturProviderModule();
    const { ctx, getProvider } = createCtx("live-transit-entur", {
      clientName: "openmapx-tests",
      journeyPlannerEndpoint: "https://api.entur.io/journey-planner/v3/graphql",
      vehiclesEndpoint: "https://api.entur.io/realtime/v2/vehicles/graphql",
    });

    mod.setup(ctx as never);
    const provider = getProvider();
    const vehiclesResult = await provider.getVehiclePositions([10.6, 59.8, 10.8, 60.0]);
    const vehicles = vehiclesResult.data as Array<Record<string, unknown>>;
    const alertsResult = await provider.getAlertsForBbox?.([10.7, 59.9, 10.8, 59.95]);
    const alerts = (alertsResult?.data ?? []) as Array<Record<string, unknown>>;

    expect(vehicles).toEqual([
      expect.objectContaining({
        id: "entur-live-vehicles:1035-2026-04-21",
        provider: "entur-live-vehicles",
        sourceId: "entur-live-vehicles",
        mode: "rail",
        displayLabel: "R14",
        secondaryLabel: "Asker-Oslo S-Kongsvinger",
        codespaceId: "VYG",
        positionKind: "observed",
        routeId: "entur:VYG:Line:R14",
        tripId: "entur:2026-04-21|VYG:ServiceJourney:1035_442947-R",
      }),
    ]);
    expect(vehiclesResult.attributions.map((a) => a.sourceId)).toContain("entur-live-vehicles");
    expect(vehiclesResult.freshness.hasRealtimeData).toBe(true);

    expect(alerts).toEqual([
      expect.objectContaining({
        id: "entur:situation-1",
        severity: "severe",
        title: "Track change",
        affectedRouteIds: ["entur:VYG:Line:R14"],
        affectedStopIds: ["entur:NSR:StopPlace:337"],
      }),
    ]);
    expect(alertsResult?.attributions.map((a) => a.sourceId)).toContain("entur-live-situations");
  });
});
