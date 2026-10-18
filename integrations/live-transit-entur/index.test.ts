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
function registerProvider(config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({
    id: "live-transit-entur",
    config,
    manifest: { dataSources: DATA_SOURCES } as never,
  });
  setup(ctx);
  const provider = ctx.registered.realtime[0];
  if (!provider?.getAlertsForBbox) throw new Error("no bbox alert provider registered");
  return { ...provider, getAlertsForBbox: provider.getAlertsForBbox.bind(provider) };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
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
          null,
          {
            vehicleId: "RUT:Vehicle:123",
            lastUpdated: "2026-03-10T10:00:00Z",
            bearing: 90,
            speed: 12.5,
            mode: "METRO",
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
        contributors: result.attributions,
        id: "entur-live-vehicles:RUT:Vehicle:123",
        provider: "entur-live-vehicles",
        sourceId: "entur-live-vehicles",
        mode: "subway",
        displayLabel: "5",
        secondaryLabel: "Vestli",
        codespaceId: "RUT",
        positionKind: "observed",
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
            validityPeriods: [
              { startTime: "2026-03-10T08:00:00Z", endTime: "2026-03-10T12:00:00Z" },
              { startTime: "2026-03-11T08:00:00Z", endTime: null },
              { startTime: null, endTime: "2026-03-12T12:00:00Z" },
            ],
            affects: [
              {
                __typename: "AffectedStopPlaceOnLine",
                line: { id: "RUT:Line:5" },
                stopPlace: { id: "NSR:StopPlace:337", latitude: 59.91, longitude: 10.75 },
                quay: { id: "NSR:Quay:1", stopPlace: { id: "NSR:StopPlace:337" } },
              },
            ],
          },
        ],
      }),
    );

    const result = await registerProvider().getAlertsForBbox?.([4, 57, 32, 71.5]);

    expect(result?.data).toEqual([
      {
        contributors: result?.attributions,
        id: "entur:RUT:Situation:9",
        providers: ["entur"],
        severity: "severe",
        effect: "incident",
        title: "Delays on line 5",
        description: "Signal failure",
        affectedRouteIds: ["entur:RUT:Line:5"],
        affectedStopIds: ["entur:NSR:StopPlace:337", "entur:NSR:Quay:1"],
        activePeriods: [
          { start: "2026-03-10T08:00:00Z", end: "2026-03-10T12:00:00Z" },
          { start: "2026-03-11T08:00:00Z", end: undefined },
          { start: undefined, end: "2026-03-12T12:00:00Z" },
        ],
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
            affects: [
              {
                __typename: "AffectedStopPlace",
                stopPlace: { id: "NSR:StopPlace:1", latitude: 0, longitude: 0 },
                quay: null,
              },
            ],
          },
        ],
      }),
    );

    const result = await registerProvider().getAlertsForBbox?.([4, 57, 32, 71.5]);
    expect(result?.data).toEqual([]);
  });
});

describe("national situation snapshot cache", () => {
  const situation = (id: string, longitude: number) => ({
    id,
    summary: [{ value: id, language: "en" }],
    affects: [
      {
        __typename: "AffectedStopPlace",
        stopPlace: { id: `stop:${id}`, latitude: 60, longitude },
        quay: null,
      },
    ],
    validityPeriods: [],
    description: [],
  });

  it("coalesces distinct concurrent areas while independently filtering each area", async () => {
    const provider = registerProvider();
    let resolve!: (response: Response) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((yes) => {
          resolve = yes;
        }),
    );
    const requests = Array.from({ length: 10 }, (_, i) =>
      provider.getAlertsForBbox([10 + i, 59, 10.5 + i, 61]),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    resolve(
      mockOk({ situations: Array.from({ length: 10 }, (_, i) => situation(String(i), 10.25 + i)) }),
    );
    const results = await Promise.all(requests);
    expect(results.map((r) => r.data.map((a) => a.id))).toEqual(
      Array.from({ length: 10 }, (_, i) => [`entur:${i}`]),
    );
  });

  it("preserves snapshot fetchedAt on hits and refreshes at 15 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T10:00:00Z"));
    const provider = registerProvider();
    mockFetch.mockImplementation(async () => mockOk({ situations: [] }));
    const first = await provider.getAlertsForBbox([4, 57, 32, 71.5]);
    vi.advanceTimersByTime(14_999);
    const cached = await provider.getAlertsForBbox([10, 59, 11, 60]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cached.freshness.fetchedAt).toBe(first.freshness.fetchedAt);
    vi.advanceTimersByTime(1);
    const refreshed = await provider.getAlertsForBbox([10, 59, 11, 60]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refreshed.freshness.fetchedAt).not.toBe(first.freshness.fetchedAt);
  });

  it("retries after a failed fetch rather than caching the failure", async () => {
    const provider = registerProvider();
    mockFetch.mockResolvedValueOnce(Response.json({ errors: [{ message: "unavailable" }] }));
    await expect(provider.getAlertsForBbox([4, 57, 32, 71.5])).rejects.toThrow("unavailable");
    mockFetch.mockResolvedValueOnce(mockOk({ situations: [] }));
    expect((await provider.getAlertsForBbox([4, 57, 32, 71.5])).data).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate the current cache from an older activation", async () => {
    const old = registerProvider();
    let resolveOld!: (response: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((yes) => {
          resolveOld = yes;
        }),
    );
    const oldRequest = old.getAlertsForBbox([4, 57, 32, 71.5]);
    const current = registerProvider({
      journeyPlannerEndpoint: "https://example.test/graphql",
      clientName: "new-client",
    });
    mockFetch.mockResolvedValueOnce(mockOk({ situations: [situation("current", 10)] }));
    await current.getAlertsForBbox([4, 57, 32, 71.5]);
    resolveOld(mockOk({ situations: [situation("old", 10)] }));
    await oldRequest;
    const hit = await current.getAlertsForBbox([4, 57, 32, 71.5]);
    expect(hit.data.map((a) => a.id)).toEqual(["entur:current"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe("https://example.test/graphql");
    expect((mockFetch.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      "ET-Client-Name": "new-client",
    });
  });
});

const affectedStop = { id: "NSR:StopPlace:variant", latitude: 60, longitude: 11 };
const affectedQuay = {
  id: "NSR:Quay:variant",
  latitude: 60,
  longitude: 11,
  stopPlace: affectedStop,
};
const affectedJourney = { id: "RUT:ServiceJourney:variant", line: { id: "RUT:Line:journey" } };

describe("current Entur situation affects", () => {
  it.each([
    {
      type: "AffectedLine",
      affect: { __typename: "AffectedLine", line: { id: "RUT:Line:direct" } },
      routes: ["entur:RUT:Line:direct"],
      stops: [],
    },
    {
      type: "AffectedServiceJourney",
      affect: { __typename: "AffectedServiceJourney", serviceJourney: affectedJourney },
      routes: ["entur:RUT:Line:journey"],
      stops: [],
    },
    {
      type: "AffectedServiceJourney with only a dated journey",
      affect: {
        __typename: "AffectedServiceJourney",
        serviceJourney: null,
        datedServiceJourney: { serviceJourney: { line: { id: "RUT:Line:dated" } } },
      },
      routes: ["entur:RUT:Line:dated"],
      stops: [],
    },
    {
      type: "AffectedStopPlace",
      affect: { __typename: "AffectedStopPlace", stopPlace: affectedStop, quay: affectedQuay },
      routes: [],
      stops: ["entur:NSR:Quay:variant", "entur:NSR:StopPlace:variant"],
    },
    {
      type: "AffectedStopPlaceOnLine",
      affect: {
        __typename: "AffectedStopPlaceOnLine",
        line: { id: "RUT:Line:direct" },
        stopPlace: affectedStop,
        quay: affectedQuay,
      },
      routes: ["entur:RUT:Line:direct"],
      stops: ["entur:NSR:Quay:variant", "entur:NSR:StopPlace:variant"],
    },
    {
      type: "AffectedStopPlaceOnServiceJourney",
      affect: {
        __typename: "AffectedStopPlaceOnServiceJourney",
        serviceJourney: affectedJourney,
        stopPlace: affectedStop,
        quay: affectedQuay,
      },
      routes: ["entur:RUT:Line:journey"],
      stops: ["entur:NSR:Quay:variant", "entur:NSR:StopPlace:variant"],
    },
    {
      type: "AffectedStopPlaceOnServiceJourney with only a dated journey",
      affect: {
        __typename: "AffectedStopPlaceOnServiceJourney",
        serviceJourney: null,
        datedServiceJourney: { serviceJourney: { line: { id: "RUT:Line:dated" } } },
        stopPlace: affectedStop,
        quay: affectedQuay,
      },
      routes: ["entur:RUT:Line:dated"],
      stops: ["entur:NSR:Quay:variant", "entur:NSR:StopPlace:variant"],
    },
    {
      type: "AffectedUnknown",
      affect: { __typename: "AffectedUnknown", description: "Unspecified effect" },
      routes: [],
      stops: [],
    },
  ])(
    "retains $type identities without inventing unrelated routes or stops",
    async ({ affect, routes, stops }) => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          situations: [
            {
              id: "RUT:Situation:variant",
              summary: [{ value: "Affected service", language: "en" }],
              description: [],
              validityPeriods: [],
              affects: [
                {
                  __typename: "AffectedStopPlace",
                  stopPlace: { id: "NSR:StopPlace:anchor", latitude: 60, longitude: 10 },
                  quay: null,
                },
                affect,
              ],
            },
          ],
        }),
      );
      const result = await registerProvider().getAlertsForBbox([9, 59, 12, 61]);
      expect(result.data).toHaveLength(1);
      expect(result.data.map((alert) => [...alert.affectedRouteIds].sort())).toEqual([routes]);
      expect(result.data.map((alert) => [...alert.affectedStopIds].sort())).toEqual([
        ["entur:NSR:StopPlace:anchor", ...stops].sort(),
      ]);
      expect(result.attributions.map((receipt) => receipt.sourceId)).toEqual([
        "entur-live-situations",
      ]);
    },
  );

  it("includes a situation located only by an affected quay's parent stop", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        situations: [
          {
            id: "RUT:Situation:quay",
            summary: [],
            description: [],
            validityPeriods: [],
            affects: [
              {
                __typename: "AffectedStopPlace",
                stopPlace: null,
                quay: {
                  id: "NSR:Quay:variant",
                  latitude: null,
                  longitude: null,
                  stopPlace: affectedStop,
                },
              },
            ],
          },
        ],
      }),
    );
    const result = await registerProvider().getAlertsForBbox([10, 59, 12, 61]);
    expect(result.data.map((alert) => alert.id)).toEqual(["entur:RUT:Situation:quay"]);
  });
});
