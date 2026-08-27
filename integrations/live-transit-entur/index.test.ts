import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const DATA_SOURCES = JSON.parse(readFileSync(join(__dirname, "manifest.json"), "utf-8"))
  .dataSources as unknown[];

function mockOk(data: unknown) {
  return Response.json({ data });
}

/** Run setup() with a capturing context and return the registered realtime provider. */
function registerProvider() {
  const ctx = createMockIntegrationContext({
    id: "live-transit-entur",
    manifest: { dataSources: DATA_SOURCES } as never,
  });
  setup(ctx);
  const provider = ctx.registered.realtime[0];
  if (!provider) throw new Error("no realtime provider registered");
  return provider;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live-transit-entur setup", () => {
  it("registers a realtime provider with vehiclePositions and bbox alerts", () => {
    const provider = registerProvider();
    expect(provider.id).toBe("live-transit-entur");
    expect(provider.capabilities.vehiclePositions).toBe(true);
    expect(provider.capabilities.alerts).toMatchObject({ byBbox: true, byStop: false });
  });
});

describe("getVehiclePositions", () => {
  it("maps an Entur vehicle into a LiveTransitVehicle with mode, ids and speed", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        vehicles: [
          {
            vehicleId: "RUT:Vehicle:123",
            lastUpdated: "2026-03-10T10:00:00Z",
            bearing: 90,
            speed: 12.5,
            mode: "metro",
            line: { lineRef: "RUT:Line:5", lineName: "Vestli", publicCode: "5" },
            serviceJourney: { id: "RUT:ServiceJourney:7", date: "2026-03-10" },
            operator: { name: "Ruter" },
            location: { latitude: 59.91, longitude: 10.75 },
            monitoredCall: { stopPointRef: "NSR:Quay:1", order: 3 },
          },
        ],
      }),
    );

    const result = await registerProvider().getVehiclePositions([4, 57, 32, 71.5]);

    expect(result.data).toEqual([
      {
        id: "entur-live-vehicles:RUT:Vehicle:123",
        provider: "entur-live-vehicles",
        sourceId: "entur-live-vehicles",
        mode: "subway",
        displayLabel: "5",
        secondaryLabel: "Vestli",
        codespaceId: "RUT",
        tripId: "entur:2026-03-10|RUT:ServiceJourney:7",
        routeId: "entur:RUT:Line:5",
        lat: 59.91,
        lng: 10.75,
        bearing: 90,
        speed: 12.5,
        label: "5\nVestli",
        currentStopId: "entur:NSR:Quay:1",
        currentStopSequence: 3,
        updatedAt: "2026-03-10T10:00:00Z",
      },
    ]);
    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0]?.sourceId).toBe("entur-live-vehicles");
  });

  it("drops vehicles missing coordinates or a lastUpdated timestamp", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        vehicles: [
          { vehicleId: "a", lastUpdated: "2026-03-10T10:00:00Z", location: { latitude: 59 } },
          { vehicleId: "b", location: { latitude: 59, longitude: 10 } },
        ],
      }),
    );

    const result = await registerProvider().getVehiclePositions([4, 57, 32, 71.5]);
    expect(result.data).toEqual([]);
  });

  it("posts the bbox query to the vehicles endpoint", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ vehicles: [] }));
    await registerProvider().getVehiclePositions([4, 57, 32, 71.5]);

    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("/realtime/v2/vehicles/graphql");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.variables).toMatchObject({ minLat: 57, minLon: 4, maxLat: 71.5, maxLon: 32 });
  });
});

describe("getAlertsForBbox", () => {
  it("maps a situation touching the bbox into a ServiceAlert", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        situations: [
          {
            id: "RUT:Situation:9",
            summary: [
              { value: "Forsinkelser", language: "no" },
              { value: "Delays on line 5", language: "en" },
            ],
            description: [{ value: "Signal failure", language: "en" }],
            reportType: "incident",
            severity: "severe",
            validityPeriod: { startTime: "2026-03-10T08:00:00Z", endTime: "2026-03-10T12:00:00Z" },
            lines: [{ id: "RUT:Line:5" }],
            stopPlaces: [{ id: "NSR:StopPlace:337", latitude: 59.91, longitude: 10.75 }],
            quays: [{ id: "NSR:Quay:1", stopPlace: { id: "NSR:StopPlace:337" } }],
          },
        ],
      }),
    );

    const result = await registerProvider().getAlertsForBbox?.([4, 57, 32, 71.5]);

    expect(result?.data).toEqual([
      {
        id: "entur:RUT:Situation:9",
        providers: ["entur"],
        severity: "severe",
        effect: "incident",
        title: "Delays on line 5",
        description: "Signal failure",
        affectedRouteIds: ["entur:RUT:Line:5"],
        affectedStopIds: ["entur:NSR:StopPlace:337", "entur:NSR:Quay:1"],
        activePeriods: [{ start: "2026-03-10T08:00:00Z", end: "2026-03-10T12:00:00Z" }],
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/journey-planner/v3/graphql");
  });

  it("excludes situations that do not touch the requested bbox", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        situations: [
          {
            id: "RUT:Situation:far",
            summary: [{ value: "x", language: "en" }],
            stopPlaces: [{ id: "NSR:StopPlace:1", latitude: 0, longitude: 0 }],
          },
        ],
      }),
    );

    const result = await registerProvider().getAlertsForBbox?.([4, 57, 32, 71.5]);
    expect(result?.data).toEqual([]);
  });
});
