import { classifyProviderFailure, ProviderPayloadError } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import departuresFixture from "./__fixtures__/departures.json";
import stopsFixture from "./__fixtures__/stops.json";
import { getDepartures, getRoute, getStop, getStops, setTransitlandApiKey } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setTransitlandApiKey("test-tl-key");
});

afterEach(() => {
  setTransitlandApiKey(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Transitland transit provider", () => {
  it("maps stops, swaps GeoJSON lng/lat, and sends route-type filters", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stops: [
          {
            onestop_id: "s-abc123",
            stop_name: "Central Station",
            geometry: { coordinates: [13.404, 52.52] },
            route_stops: [{ route: { route_type: 3 } }],
          },
        ],
      }),
    );

    const stops = await getStops([13.3, 52.4, 13.5, 52.6], ["bus"]);

    expect(stops).toEqual([
      {
        id: "tl:s-abc123",
        name: "Central Station",
        lat: 52.52,
        lng: 13.404,
        modes: ["bus"],
        platformCode: undefined,
        parentStationId: undefined,
        provider: "transitland",
      },
    ]);

    const fetchUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(fetchUrl).toContain("apikey=test-tl-key");
    expect(fetchUrl).toContain("served_by_route_types=3%2C11");
  });

  it("strips tl: prefixes when looking up a single stop and route", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stops: [
          {
            onestop_id: "s-stop1",
            stop_name: "Stop 1",
            geometry: { coordinates: [2.35, 48.86] },
            route_stops: [],
          },
        ],
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockOk({
        routes: [
          {
            onestop_id: "r-line1",
            route_short_name: "S1",
            route_long_name: "S-Bahn 1",
            route_type: 2,
            agency: { agency_name: "DB" },
            geometry: { type: "LineString", coordinates: [[13.4, 52.5]] },
          },
        ],
      }),
    );

    const stop = await getStop("tl:s-stop1");
    const route = await getRoute("tl:r-line1");

    expect(stop?.id).toBe("tl:s-stop1");
    expect(route).toMatchObject({
      id: "tl:r-line1",
      shortName: "S1",
      longName: "S-Bahn 1",
      mode: "rail",
      operatorName: "DB",
    });

    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("onestop_id=s-stop1");
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("onestop_id=r-line1");
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("include_geometry=true");
  });

  it("reads documented departure instants and realtime estimates", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(departuresFixture));

    const departures = await getDepartures("tl:s-9q9p1bc1td-lakemerritt", 30);

    expect(departures).toEqual([
      {
        tripId: "BA:1965768",
        route: {
          id: "tl:r-9q9n-blue~s",
          shortName: "Blue-S",
          longName: "Dublin/Pleasanton to Daly City",
          mode: "subway",
          color: "0099CC",
        },
        headsign: "Daly City",
        scheduledAt: "2026-11-09T16:24:00.000Z",
        expectedAt: "2026-11-09T16:25:19.000Z",
        delaySeconds: 79,
        platform: "2",
        canceled: false,
      },
      expect.objectContaining({
        tripId: "BA:1965375",
        scheduledAt: "2026-11-09T16:29:00.000Z",
        expectedAt: "2026-11-09T16:31:23.000Z",
        delaySeconds: 143,
      }),
    ]);
    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v2/rest/stops/s-9q9p1bc1td-lakemerritt/departures");
    expect(url.searchParams.get("next")).toBe("1800");
    expect(url.searchParams.get("apikey")).toBe("test-tl-key");
  });

  it("takes the first stop's board when the envelope lists several stops", async () => {
    const [first] = departuresFixture.stops;
    mockFetch.mockResolvedValueOnce(
      mockOk({ stops: [first, { platform_code: "9", departures: [] }] }),
    );

    const departures = await getDepartures("tl:s-9q9p1bc1td-lakemerritt");

    expect(departures.map((d) => [d.tripId, d.platform])).toEqual([
      ["BA:1965768", "2"],
      ["BA:1965375", "2"],
    ]);
  });

  it("marks a canceled trip and omits realtime when no estimate exists", async () => {
    const [first] = departuresFixture.stops[0].departures;
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stops: [
          {
            departures: [
              {
                ...first,
                departure: { ...first.departure, estimated_utc: null },
                trip: { ...first.trip, schedule_relationship: "CANCELED" },
              },
            ],
          },
        ],
      }),
    );

    const [departure] = await getDepartures("tl:s-stop1");

    expect(departure).toMatchObject({ canceled: true, scheduledAt: "2026-11-09T16:24:00.000Z" });
    expect(departure?.expectedAt).toBeUndefined();
    expect(departure?.delaySeconds).toBeUndefined();
  });

  it("keeps valid departures when a neighbour lacks its scheduled instant", async () => {
    const [first, second] = departuresFixture.stops[0].departures;
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stops: [{ departures: [{ ...first, departure: { scheduled: "08:24:00" } }, second] }],
      }),
    );

    const departures = await getDepartures("tl:s-stop1");

    expect(departures.map((d) => d.tripId)).toEqual(["BA:1965375"]);
  });

  it.each([
    ["a body without stops", { departures: [] }],
    ["departures that are not a list", { stops: [{ departures: {} }] }],
    ["only GTFS clock times", { stops: [{ departures: [{ departure_time: "08:24:00" }] }] }],
  ])("reports %s as an invalid payload", async (_case, body) => {
    mockFetch.mockResolvedValueOnce(mockOk(body));

    const failure = await getDepartures("tl:s-stop1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderPayloadError);
    expect(classifyProviderFailure(failure)).toBe("invalid_payload");
  });

  it("maps a documented stop and rejects stops without coordinates", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(stopsFixture));
    await expect(getStops([-122.7, 45.5, -122.6, 45.6])).resolves.toEqual([
      expect.objectContaining({
        id: "tl:s-c20fbm8z95-swcolumbia~parkave",
        name: "SW Columbia & Park Ave",
        lat: 45.514919,
        lng: -122.683248,
      }),
    ]);

    mockFetch.mockResolvedValueOnce(mockOk({ stops: [{ onestop_id: "s-x", stop_name: "X" }] }));
    await expect(getStops([0, 0, 1, 1])).rejects.toBeInstanceOf(ProviderPayloadError);
  });

  it("treats a 404 for a caller's stop id as bad input and a 404 on the stop list as a failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const unknown = await getDepartures("tl:s-bogus").catch((error: unknown) => error);
    expect((unknown as Error).message).toBe("Unknown Transitland timetable identifier");
    expect(classifyProviderFailure(unknown)).toBe("input");

    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const retired = await getStops([0, 0, 1, 1]).catch((error: unknown) => error);
    expect(classifyProviderFailure(retired)).toBe("connection");
  });

  it("reports a failed stop list as unavailable, not as no stops", async () => {
    mockFetch.mockResolvedValueOnce(new Response("down", { status: 502 }));

    const failure = await getStops([0, 0, 1, 1]).catch((error: unknown) => error);

    expect((failure as Error).message).toBe("Transitland stops unavailable");
    expect((failure as Error).message).not.toContain("test-tl-key");
    expect(classifyProviderFailure(failure)).toBe("upstream_5xx");
  });

  it("returns no Transitland data without an API key", async () => {
    setTransitlandApiKey(undefined);

    const stops = await getStops([0, 0, 1, 1]);
    const stop = await getStop("tl:test");

    expect(stops).toEqual([]);
    expect(stop).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports a failed board as unavailable without the keyed request URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const failure = await getDepartures("tl:s-stop1").catch((error: unknown) => error);

    expect((failure as Error).message).toBe("Transitland timetable unavailable");
  });
});
