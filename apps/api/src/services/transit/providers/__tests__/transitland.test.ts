import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch — transitland.ts calls global fetch via tlFetch
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  process.env.TRANSIT_LAND_API_KEY = "test-tl-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TRANSIT_LAND_API_KEY;
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

// Dynamic import to pick up stubbed fetch and env
async function loadModule() {
  return import("../transitland.js");
}

describe("transitland provider", () => {
  describe("getStops", () => {
    it("returns stops with tl: prefix and correct field mapping", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-abc123",
              stop_name: "Central Station",
              geometry: { coordinates: [13.404, 52.52] }, // [lng, lat]
              route_stops: [{ route: { route_type: 2 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([13.3, 52.4, 13.5, 52.6]);

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("tl:s-abc123");
      expect(stops[0].name).toBe("Central Station");
      // GeoJSON coordinates are [lng, lat] — verify lat/lng are swapped correctly
      expect(stops[0].lat).toBe(52.52);
      expect(stops[0].lng).toBe(13.404);
      expect(stops[0].modes).toContain("rail"); // route_type 2 → rail
      expect(stops[0].provider).toBe("transitland");
    });

    it("maps GTFS route_type 0 → tram", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-tram",
              stop_name: "Tram Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 0 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("tram");
    });

    it("maps GTFS route_type 1 → subway", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-sub",
              stop_name: "Subway Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 1 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("subway");
    });

    it("maps GTFS route_type 3 → bus", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-bus",
              stop_name: "Bus Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 3 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("bus");
    });

    it("maps GTFS route_type 4 → ferry", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-ferry",
              stop_name: "Ferry Terminal",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 4 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("ferry");
    });

    it("maps GTFS route_type 5 → cable_car", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-cable",
              stop_name: "Cable Car Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 5 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("cable_car");
    });

    it("maps GTFS route_type 6 → gondola", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-gondola",
              stop_name: "Gondola Station",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 6 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("gondola");
    });

    it("maps GTFS route_type 12 → monorail", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-mono",
              stop_name: "Monorail Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [{ route: { route_type: 12 } }],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("monorail");
    });

    it("defaults modes to [bus] when no route_stops provided", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-noroutes",
              stop_name: "Unknown Mode Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toEqual(["bus"]);
    });

    it("includes apikey in request URL", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [] }));

      const { getStops } = await loadModule();
      await getStops([0, 0, 1, 1]);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("apikey=test-tl-key");
    });

    it("includes bbox in request URL", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [] }));

      const { getStops } = await loadModule();
      await getStops([-73.99, 40.7, -73.97, 40.72]);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("bbox=");
      expect(fetchUrl).toContain("-73.99");
      expect(fetchUrl).toContain("40.7");
    });

    it("includes mode filter when modes specified", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [] }));

      const { getStops } = await loadModule();
      await getStops([0, 0, 1, 1], ["bus"]);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("served_by_route_types=");
      // route_type 3 and 11 both map to bus
      expect(fetchUrl).toMatch(/served_by_route_types=.*3/);
    });

    it("returns empty array when TRANSIT_LAND_API_KEY is not set", async () => {
      delete process.env.TRANSIT_LAND_API_KEY;

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      // getStops catches the apiKey() throw and returns []
      expect(stops).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops).toEqual([]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops).toEqual([]);
    });

    it("maps optional fields: platformCode and parentStationId", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-child",
              stop_name: "Platform A",
              geometry: { coordinates: [0, 0] },
              route_stops: [],
              platform_code: "A",
              parent_station_onestop_id: "s-parent",
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].platformCode).toBe("A");
      expect(stops[0].parentStationId).toBe("tl:s-parent");
    });
  });

  describe("getStop", () => {
    it("returns normalized stop for valid onestop_id", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-xyz",
              stop_name: "Test Stop",
              geometry: { coordinates: [2.35, 48.86] },
              route_stops: [{ route: { route_type: 1 } }],
            },
          ],
        }),
      );

      const { getStop } = await loadModule();
      const stop = await getStop("tl:s-xyz");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("tl:s-xyz");
      expect(stop?.name).toBe("Test Stop");
      expect(stop?.lat).toBe(48.86);
      expect(stop?.lng).toBe(2.35);
      expect(stop?.modes).toContain("subway");
    });

    it("strips tl: prefix before calling API", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-xyz",
              stop_name: "X",
              geometry: { coordinates: [0, 0] },
              route_stops: [],
            },
          ],
        }),
      );

      const { getStop } = await loadModule();
      await getStop("tl:s-xyz");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("onestop_id=s-xyz");
      expect(fetchUrl).not.toContain("tl%3A");
    });

    it("works with raw id (no tl: prefix)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              onestop_id: "s-raw",
              stop_name: "Raw Stop",
              geometry: { coordinates: [0, 0] },
              route_stops: [],
            },
          ],
        }),
      );

      const { getStop } = await loadModule();
      const stop = await getStop("s-raw");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("tl:s-raw");
    });

    it("returns null when stops array is empty", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [] }));

      const { getStop } = await loadModule();
      const stop = await getStop("tl:nonexistent");

      expect(stop).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(404));

      const { getStop } = await loadModule();
      const stop = await getStop("tl:missing");

      expect(stop).toBeNull();
    });

    it("returns null on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const { getStop } = await loadModule();
      const stop = await getStop("tl:error");

      expect(stop).toBeNull();
    });
  });

  describe("getDepartures", () => {
    it("returns departures with tl: prefix on route ids", async () => {
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
                      route_color: "FF0000",
                    },
                  },
                  departure_time: "2026-03-10T10:00:00Z",
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s-stop1");

      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("trip-001");
      expect(deps[0].route.id).toBe("tl:r-line1");
      expect(deps[0].route.shortName).toBe("S1");
      expect(deps[0].route.longName).toBe("S-Bahn 1");
      expect(deps[0].route.mode).toBe("rail");
      expect(deps[0].route.color).toBe("FF0000");
      expect(deps[0].headsign).toBe("Airport");
      expect(deps[0].scheduledAt).toBe("2026-03-10T10:00:00Z");
    });

    it("computes delaySeconds from scheduled vs actual times", async () => {
      const scheduled = "2026-03-10T10:00:00Z";
      const actual = "2026-03-10T10:05:00Z"; // 5 min late

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: { trip_id: "t1", route: { route_type: 3 } },
                  departure_time: scheduled,
                  departure_time_actual: actual,
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps[0].scheduledAt).toBe(scheduled);
      expect(deps[0].expectedAt).toBe(actual);
      expect(deps[0].delaySeconds).toBe(300); // 5 * 60
    });

    it("sets delaySeconds to undefined when on time (delay = 0)", async () => {
      const time = "2026-03-10T10:00:00Z";

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: { trip_id: "t1", route: { route_type: 3 } },
                  departure_time: time,
                  departure_time_actual: time,
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      // delaySeconds is only set when non-zero
      expect(deps[0].delaySeconds).toBeUndefined();
    });

    it("sets delaySeconds to undefined when no actual time provided", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: { trip_id: "t1", route: { route_type: 3 } },
                  departure_time: "2026-03-10T10:00:00Z",
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps[0].delaySeconds).toBeUndefined();
    });

    it("computes negative delaySeconds when running early", async () => {
      const scheduled = "2026-03-10T10:05:00Z";
      const actual = "2026-03-10T10:03:00Z"; // 2 min early

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: { trip_id: "t1", route: { route_type: 3 } },
                  departure_time: scheduled,
                  departure_time_actual: actual,
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps[0].delaySeconds).toBe(-120);
    });

    it("strips tl: prefix from stopId before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [{ departures: [] }] }));

      const { getDepartures } = await loadModule();
      await getDepartures("tl:s-abc");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/stops/s-abc/departures");
      expect(fetchUrl).not.toContain("tl%3A");
    });

    it("always sets canceled to false", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: { trip_id: "t1", route: { route_type: 3 } },
                  departure_time: "2026-03-10T10:00:00Z",
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("s1");

      expect(deps[0].canceled).toBe(false);
    });

    it("returns empty array when stops array is empty", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stops: [] }));

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps).toEqual([]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps).toEqual([]);
    });

    it("strips route_color hash prefix", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stops: [
            {
              departures: [
                {
                  trip: {
                    trip_id: "t1",
                    route: {
                      onestop_id: "r1",
                      route_type: 3,
                      route_color: "#0099CC",
                    },
                  },
                  departure_time: "2026-03-10T10:00:00Z",
                },
              ],
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tl:s1");

      expect(deps[0].route.color).toBe("0099CC");
    });
  });

  describe("getRoutes", () => {
    it("returns routes with tl: prefix and mapped mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-metro1",
              route_short_name: "M1",
              route_long_name: "Metro Line 1",
              route_type: 1,
              route_color: "0000FF",
              route_text_color: "FFFFFF",
              operator: { name: "Metro Corp" },
            },
          ],
        }),
      );

      const { getRoutes } = await loadModule();
      const routes = await getRoutes({ bbox: [13.3, 52.4, 13.5, 52.6] });

      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe("tl:r-metro1");
      expect(routes[0].shortName).toBe("M1");
      expect(routes[0].longName).toBe("Metro Line 1");
      expect(routes[0].mode).toBe("subway"); // route_type 1
      expect(routes[0].color).toBe("0000FF");
      expect(routes[0].textColor).toBe("FFFFFF");
      expect(routes[0].operatorName).toBe("Metro Corp");
    });

    it("strips hash prefix from color", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-bus",
              route_short_name: "42",
              route_long_name: "Line 42",
              route_type: 3,
              route_color: "#FF5500",
              operator: { name: "Bus Co" },
            },
          ],
        }),
      );

      const { getRoutes } = await loadModule();
      const routes = await getRoutes({});

      expect(routes[0].color).toBe("FF5500");
    });

    it("uses agency.agency_name as fallback for operatorName", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-1",
              route_short_name: "1",
              route_long_name: "Bus 1",
              route_type: 3,
              agency: { agency_name: "Fallback Agency" },
            },
          ],
        }),
      );

      const { getRoutes } = await loadModule();
      const routes = await getRoutes({});

      expect(routes[0].operatorName).toBe("Fallback Agency");
    });

    it("filters by stopId when provided", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ routes: [] }));

      const { getRoutes } = await loadModule();
      await getRoutes({ stopId: "tl:s-stop1" });

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("served_by_stops=s-stop1");
    });

    it("returns empty array on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const { getRoutes } = await loadModule();
      const routes = await getRoutes({ bbox: [0, 0, 1, 1] });

      expect(routes).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getRoutes } = await loadModule();
      const routes = await getRoutes({});

      expect(routes).toEqual([]);
    });
  });

  describe("getRoute", () => {
    it("returns single route with geometry when present", async () => {
      const geometry = {
        type: "LineString",
        coordinates: [
          [13.4, 52.5],
          [13.42, 52.52],
        ],
      };

      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-s1",
              route_short_name: "S1",
              route_long_name: "S-Bahn 1",
              route_type: 2,
              operator: { name: "DB" },
              geometry,
            },
          ],
        }),
      );

      const { getRoute } = await loadModule();
      const route = await getRoute("tl:r-s1");

      expect(route).not.toBeNull();
      expect(route?.id).toBe("tl:r-s1");
      expect(route?.mode).toBe("rail");
      expect(route?.geometry).toEqual(geometry);
    });

    it("passes include_geometry=true in the request", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-test",
              route_short_name: "T",
              route_long_name: "Test",
              route_type: 3,
              operator: { name: "Test Co" },
            },
          ],
        }),
      );

      const { getRoute } = await loadModule();
      await getRoute("tl:r-test");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("include_geometry=true");
    });

    it("strips tl: prefix from id before calling API", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-abc",
              route_short_name: "A",
              route_long_name: "A Line",
              route_type: 3,
              operator: { name: "Co" },
            },
          ],
        }),
      );

      const { getRoute } = await loadModule();
      await getRoute("tl:r-abc");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("onestop_id=r-abc");
      expect(fetchUrl).not.toContain("tl%3A");
    });

    it("returns null when routes array is empty", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ routes: [] }));

      const { getRoute } = await loadModule();
      const route = await getRoute("tl:nonexistent");

      expect(route).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(404));

      const { getRoute } = await loadModule();
      const route = await getRoute("tl:missing");

      expect(route).toBeNull();
    });

    it("returns null on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const { getRoute } = await loadModule();
      const route = await getRoute("tl:error");

      expect(route).toBeNull();
    });

    it("defaults mode to bus for unknown route_type", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          routes: [
            {
              onestop_id: "r-unk",
              route_short_name: "?",
              route_long_name: "Unknown",
              route_type: 99,
              operator: { name: "Co" },
            },
          ],
        }),
      );

      const { getRoute } = await loadModule();
      const route = await getRoute("tl:r-unk");

      expect(route?.mode).toBe("bus");
    });
  });
});
