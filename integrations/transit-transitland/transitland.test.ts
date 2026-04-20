import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDepartures, getRoute, getStop, getStops, setTransitlandApiKey } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
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
            operator: { name: "DB" },
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

  it("maps departures including route ids, colors, and delays", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stops: [
          {
            departures: [
              {
                trip: {
                  trip_id: "trip-001",
                  trip_headsign: "Airport",
                  route: {
                    onestop_id: "r-line1",
                    route_short_name: "S1",
                    route_long_name: "S-Bahn 1",
                    route_type: 2,
                    route_color: "#FF0000",
                  },
                },
                departure_time: "2026-03-10T10:00:00Z",
                departure_time_actual: "2026-03-10T10:05:00Z",
              },
            ],
          },
        ],
      }),
    );

    const departures = await getDepartures("tl:s-stop1");

    expect(departures).toEqual([
      {
        tripId: "trip-001",
        route: {
          id: "tl:r-line1",
          shortName: "S1",
          longName: "S-Bahn 1",
          mode: "rail",
          color: "FF0000",
        },
        headsign: "Airport",
        scheduledAt: "2026-03-10T10:00:00Z",
        expectedAt: "2026-03-10T10:05:00Z",
        delaySeconds: 300,
        platform: undefined,
        canceled: false,
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/stops/s-stop1/departures");
  });

  it("returns no Transitland data without an API key", async () => {
    setTransitlandApiKey(undefined);

    const stops = await getStops([0, 0, 1, 1]);
    const stop = await getStop("tl:test");

    expect(stops).toEqual([]);
    expect(stop).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
