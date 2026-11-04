import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAlerts,
  getDepartures,
  getRouteStopSequence,
  getStopAlerts,
  getStops,
  searchByName,
  setTflApiKey,
} from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setTflApiKey("test-tfl-key");
});

afterEach(() => {
  setTflApiKey(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TfL transit provider", () => {
  it("maps stop modes and clamps the search radius", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stopPoints: [
          {
            naptanId: "940GZZLUOXC",
            commonName: "Oxford Circus",
            lat: 51.5152,
            lon: -0.1415,
            modes: ["tube", "bus"],
          },
          {
            naptanId: "910GPADTLL",
            commonName: "Paddington Elizabeth line",
            lat: 51.5167,
            lon: -0.1769,
            modes: ["elizabeth-line"],
          },
        ],
      }),
    );

    const stops = await getStops(51.51, -0.14, 5000);

    expect(stops[0]).toMatchObject({
      id: "tfl:940GZZLUOXC",
      codes: [{ value: "940GZZLUOXC", namespace: "naptan" }],
      name: "Oxford Circus",
      modes: ["subway", "bus"],
      provider: "tfl",
    });
    expect(stops[1]?.modes).toEqual(["rail"]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("radius=1000");
  });

  it("filters and sorts departures within the requested window", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          vehicleId: "v2",
          lineId: "central",
          lineName: "Central",
          modeName: "tube",
          destinationName: "Epping",
          expectedArrival: "2026-03-10T10:07:00Z",
          timeToStation: 420,
          platformName: "Westbound",
        },
        {
          vehicleId: "v1",
          lineId: "central",
          lineName: "Central",
          modeName: "tube",
          destinationName: "Ealing Broadway",
          expectedArrival: "2026-03-10T10:03:00Z",
          timeToStation: 180,
          platformName: "Eastbound",
        },
        {
          vehicleId: "v3",
          lineId: "central",
          lineName: "Central",
          modeName: "tube",
          expectedArrival: "2026-03-10T11:30:00Z",
          timeToStation: 5400,
        },
      ]),
    );

    const { departures } = await getDepartures("tfl:940GZZLUOXC", 10);

    expect(departures).toHaveLength(2);
    expect(departures[0]).toMatchObject({
      tripId: "v1",
      route: { id: "tfl:central", shortName: "Central", mode: "subway" },
      headsign: "Ealing Broadway",
      scheduledAt: "2026-03-10T10:03:00Z",
      expectedAt: "2026-03-10T10:03:00Z",
      platform: "Eastbound",
    });
    expect(departures[1]?.tripId).toBe("v2");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/StopPoint/940GZZLUOXC/Arrivals");
  });

  it("maps line alerts and strips HTML from disruption reasons", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "central",
          name: "Central",
          lineStatuses: [
            {
              statusSeverity: 5,
              statusSeverityDescription: "Minor Delays",
              reason: "Signal issue <b>cleared</b>",
            },
          ],
        },
      ]),
    );

    const alerts = await getAlerts();

    expect(alerts).toEqual([
      {
        id: "tfl:status:central",
        providers: ["tfl"],
        severity: "warning",
        effect: "Minor Delays",
        title: "Central: Minor Delays",
        description: "Signal issue cleared",
        affectedRouteIds: ["tfl:central"],
        affectedStopIds: [],
        activePeriods: [],
      },
    ]);
  });

  it("strips the tfl: prefix when requesting route stop sequences", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stopPointSequences: [
          {
            stopPoint: [
              { id: "s1", name: "Stop 1", lat: 51.5, lon: -0.1 },
              { id: "s2", name: "Stop 2", lat: 51.51, lon: -0.11 },
            ],
          },
        ],
      }),
    );

    const stops = await getRouteStopSequence("tfl:central");

    expect(stops).toEqual([
      { id: "tfl:s1", name: "Stop 1", lat: 51.5, lng: -0.1, sequence: 0 },
      { id: "tfl:s2", name: "Stop 2", lat: 51.51, lng: -0.11, sequence: 1 },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/Line/central/Route/Sequence/outbound");
  });

  it("reports a failed stop search without exposing the keyed request URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const failure = await searchByName("Oxford Circus", 5).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("TfL stop search unavailable");
    expect((failure as Error).message).not.toContain("test-tfl-key");
  });

  it("returns no stops when the search succeeds without matches", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ matches: [] }));

    expect(await searchByName("Nowhere", 5)).toEqual([]);
  });

  it.each([
    ["stop alerts", () => getStopAlerts("tfl:940GZZLUOXC")],
    ["timetable", () => getDepartures("tfl:940GZZLUOXC", 10)],
  ])("reports failed %s without exposing the keyed request URL", async (what, lookup) => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const failure = await lookup().catch((error: unknown) => error);

    expect((failure as Error).message).toBe(`TfL ${what} unavailable`);
  });
});

describe("TfL departure board age", () => {
  const arrival = (vehicleId: string, timestamp?: string) => ({
    vehicleId,
    lineId: "central",
    lineName: "Central",
    modeName: "tube",
    destinationName: "Epping",
    expectedArrival: "2026-03-10T10:07:00Z",
    timeToStation: 120,
    ...(timestamp ? { timestamp } : {}),
  });

  it("is the oldest prediction time on the board", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([arrival("v1", "2026-03-10T10:00:40Z"), arrival("v2", "2026-03-10T10:00:10Z")]),
    );
    expect((await getDepartures("tfl:940GZZLUOXC", 10)).dataAsOf).toBe("2026-03-10T10:00:10.000Z");
  });

  it("is unknown when a prediction states no time", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([arrival("v1", "2026-03-10T10:00:40Z"), arrival("v2")]));
    expect((await getDepartures("tfl:940GZZLUOXC", 10)).dataAsOf).toBeUndefined();
  });
});
