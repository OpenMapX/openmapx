import { classifyProviderFailure, ProviderPayloadError } from "@openmapx/integration-framework";
import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import arrivalsFixture from "./__fixtures__/arrivals.json";
import stopPointsFixture from "./__fixtures__/stop-points.json";
import {
  getAlerts,
  getDepartures,
  getRouteAlerts,
  getRouteStopSequence,
  getStop,
  getStopAlerts,
  getStops,
  searchByName,
  type TflAccess,
} from "./provider.js";

/** Called with each request URL; answers like fetch. */
let mockFetch: ReturnType<typeof vi.fn>;
let access: TflAccess;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  const http = fakeHttpClient(async ({ url }) => {
    const response = (await mockFetch(url)) as Response;
    return response.ok ? response.json() : httpStatus(response.status);
  });
  access = { http, apiKey: "test-tfl-key" };
});

describe("TfL payload validation", () => {
  it("maps the documented prediction shape and requests the stop's arrivals", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(arrivalsFixture));

    const board = await getDepartures(access, "tfl:940GZZLUOXC", 30);

    expect(board.departures.map((d) => [d.route.id, d.expectedAt, d.platform])).toEqual([
      ["tfl:central", "2026-11-10T09:00:42Z", "Westbound - Platform 1"],
      ["tfl:victoria", "2026-11-10T09:01:39Z", "Southbound - Platform 5"],
    ]);
    expect(board.dataAsOf).toBe("2026-11-10T09:00:01.765Z");
    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/StopPoint/940GZZLUOXC/Arrivals");
    expect(url.searchParams.get("app_key")).toBe("test-tfl-key");
  });

  it("drops a prediction without an expected arrival and keeps its neighbours", async () => {
    const [first, second] = arrivalsFixture;
    mockFetch.mockResolvedValueOnce(mockOk([{ ...first, expectedArrival: null }, second]));

    const board = await getDepartures(access, "tfl:940GZZLUOXC", 30);

    expect(board.departures.map((d) => d.tripId)).toEqual(["214"]);
  });

  it.each([
    ["an object instead of predictions", { message: "ok" }],
    ["predictions without times", [{ lineId: "central" }]],
  ])("reports %s as an invalid payload", async (_case, body) => {
    mockFetch.mockResolvedValueOnce(mockOk(body));

    const failure = await getDepartures(access, "tfl:940GZZLUOXC", 30).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProviderPayloadError);
    expect(classifyProviderFailure(failure)).toBe("invalid_payload");
  });

  it("never places a stop without coordinates at null island", async () => {
    const [stop] = stopPointsFixture.stopPoints;
    mockFetch.mockResolvedValueOnce(
      mockOk({ stopPoints: [stop, { ...stop, naptanId: "940GZZLUXXX", lat: null, lon: null }] }),
    );

    const stops = await getStops(access, 51.515, -0.142, 400);

    expect(stops.map((s) => [s.id, s.lat, s.lng])).toEqual([
      ["tfl:940GZZLUOXC", 51.515224, -0.141903],
    ]);
    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("radius")).toBe("400");
    expect(url.searchParams.get("lat")).toBe("51.515");
  });

  it("reports failed stop, alert and sequence requests instead of empty results", async () => {
    mockFetch.mockImplementation(async () => new Response("busy", { status: 503 }));

    for (const call of [
      () => getStops(access, 51.5, -0.1, 300),
      () => getAlerts(access),
      () => getRouteStopSequence(access, "tfl:victoria"),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("test-tfl-key");
      expect(classifyProviderFailure(failure)).toBe("upstream_5xx");
    }
  });

  it("answers no stops for search text that would collapse into another TfL path", async () => {
    for (const query of ["", ".", ".."])
      await expect(searchByName(access, query, 5)).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a 404 for a caller's stop or line as bad input", async () => {
    mockFetch.mockImplementation(async () => new Response("not found", { status: 404 }));

    for (const call of [
      () => getDepartures(access, "tfl:940GZZLUBOGUS", 30),
      () => getStopAlerts(access, "tfl:940GZZLUBOGUS"),
      () => getRouteAlerts(access, "tfl:bogus-line"),
      () => getRouteStopSequence(access, "tfl:bogus-line"),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(classifyProviderFailure(failure)).toBe("input");
      expect((failure as Error).message).not.toContain("test-tfl-key");
    }
  });

  it("still counts a 404 on the fixed mode-status, nearby and stop-search endpoints", async () => {
    mockFetch.mockImplementation(async () => new Response("not found", { status: 404 }));

    for (const call of [
      () => getAlerts(access),
      () => getStops(access, 51.5, -0.1, 300),
      () => searchByName(access, "no such place", 5),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(classifyProviderFailure(failure)).toBe("connection");
    }
  });

  it("answers no stop for an unknown NaPTAN id and rejects a stop without coordinates", async () => {
    mockFetch.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(getStop(access, "tfl:940GZZLUNOPE")).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce(mockOk({ naptanId: "940GZZLUOXC", commonName: "Oxford" }));
    await expect(getStop(access, "tfl:940GZZLUOXC")).rejects.toBeInstanceOf(ProviderPayloadError);
  });
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

    const stops = await getStops(access, 51.51, -0.14, 5000);

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

    const { departures } = await getDepartures(access, "tfl:940GZZLUOXC", 10);

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

    const alerts = await getAlerts(access);

    expect(alerts).toEqual([
      {
        id: "tfl:status:central:5",
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

  it("alerts for disruption codes above Good Service", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "northern",
          name: "Northern",
          lineStatuses: [
            {
              statusSeverity: 16,
              statusSeverityDescription: "Not Running",
              reason: "No service between A and B",
            },
          ],
        },
        {
          id: "district",
          name: "District",
          lineStatuses: [{ statusSeverity: 11, statusSeverityDescription: "Part Closed" }],
        },
      ]),
    );

    const alerts = await getAlerts(access);

    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      id: "tfl:status:northern:16",
      severity: "severe",
      title: "Northern: Not Running",
      description: "No service between A and B",
    });
    expect(alerts[1]).toMatchObject({
      id: "tfl:status:district:11",
      severity: "warning",
      title: "District: Part Closed",
    });
  });

  it("maps every documented notice code", async () => {
    const notices: Array<[number, string]> = [
      [12, "Exit Only"],
      [13, "No Step Free Access"],
      [14, "Change of frequency"],
      [15, "Diverted"],
      [17, "Issues Reported"],
      [19, "Information"],
    ];
    mockFetch.mockResolvedValueOnce(
      mockOk(
        notices.map(([code, description]) => ({
          id: `line-${code}`,
          name: `Line ${code}`,
          lineStatuses: [{ statusSeverity: code, statusSeverityDescription: description }],
        })),
      ),
    );

    const alerts = await getAlerts(access);

    expect(alerts.map((alert) => alert.severity)).toEqual([
      "warning",
      "warning",
      "info",
      "warning",
      "warning",
      "info",
    ]);
  });

  it("raises no alert for good service, no issues or the overnight closure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "central",
          name: "Central",
          lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: "Good Service" }],
        },
        {
          id: "victoria",
          name: "Victoria",
          lineStatuses: [{ statusSeverity: 18, statusSeverityDescription: "No Issues" }],
        },
        {
          id: "jubilee",
          name: "Jubilee",
          lineStatuses: [{ statusSeverity: 20, statusSeverityDescription: "Service Closed" }],
        },
        { id: "bakerloo", name: "Bakerloo", lineStatuses: [{ statusSeverity: null }] },
      ]),
    );

    expect(await getAlerts(access)).toEqual([]);
  });

  it("represents every simultaneous status on a line", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "piccadilly",
          name: "Piccadilly",
          lineStatuses: [
            {
              statusSeverity: 9,
              statusSeverityDescription: "Minor Delays",
              reason: "Earlier signal failure",
            },
            {
              statusSeverity: 5,
              statusSeverityDescription: "Part Closure",
              reason: "No service west of Acton Town",
            },
            {
              statusSeverity: 5,
              statusSeverityDescription: "Part Closure",
              reason: "No service Hyde Park Corner to Holborn",
            },
            { statusSeverity: 10, statusSeverityDescription: "Good Service" },
          ],
        },
      ]),
    );

    const alerts = await getAlerts(access);

    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      id: "tfl:status:piccadilly:9",
      severity: "info",
      description: "Earlier signal failure",
    });
    expect(alerts[1]).toMatchObject({
      id: "tfl:status:piccadilly:5",
      severity: "warning",
      description: "No service west of Acton Town\n\nNo service Hyde Park Corner to Holborn",
    });
  });

  it("keeps an existing low code mapping", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "metropolitan",
          name: "Metropolitan",
          lineStatuses: [{ statusSeverity: 6, statusSeverityDescription: "Severe Delays" }],
        },
        {
          id: "circle",
          name: "Circle",
          lineStatuses: [{ statusSeverity: 2, statusSeverityDescription: "Suspended" }],
        },
      ]),
    );

    const alerts = await getAlerts(access);

    expect(alerts.map((alert) => alert.severity)).toEqual(["warning", "severe"]);
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

    const stops = await getRouteStopSequence(access, "tfl:central");

    expect(stops).toEqual([
      { id: "tfl:s1", name: "Stop 1", lat: 51.5, lng: -0.1, sequence: 0 },
      { id: "tfl:s2", name: "Stop 2", lat: 51.51, lng: -0.11, sequence: 1 },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/Line/central/Route/Sequence/outbound");
  });

  it("reports a failed stop search without exposing the keyed request URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const failure = await searchByName(access, "Oxford Circus", 5).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("TfL stop search unavailable");
    expect((failure as Error).message).not.toContain("test-tfl-key");
  });

  it("returns no stops when the search succeeds without matches", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ matches: [] }));

    expect(await searchByName(access, "Nowhere", 5)).toEqual([]);
  });

  it.each([
    ["stop alerts", () => getStopAlerts(access, "tfl:940GZZLUOXC")],
    ["timetable", () => getDepartures(access, "tfl:940GZZLUOXC", 10)],
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
    expect((await getDepartures(access, "tfl:940GZZLUOXC", 10)).dataAsOf).toBe(
      "2026-03-10T10:00:10.000Z",
    );
  });

  it("is unknown when a prediction states no time", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([arrival("v1", "2026-03-10T10:00:40Z"), arrival("v2")]));
    expect((await getDepartures(access, "tfl:940GZZLUOXC", 10)).dataAsOf).toBeUndefined();
  });
});
