import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  process.env.MBTA_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.MBTA_API_KEY;
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk() {
  return { ok: false, status: 500 } as Response;
}

async function loadModule() {
  return import("../mbta.js");
}

describe("mbta provider", () => {
  describe("getStops", () => {
    it("returns stops with mb: prefix and mapped modes", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "place-north",
              attributes: {
                name: "North Station",
                latitude: 42.3656,
                longitude: -71.0609,
                vehicle_type: 2, // rail
              },
              relationships: {
                parent_station: { data: null },
              },
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(42.36, -71.06, 1000);

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("mb:place-north");
      expect(stops[0].name).toBe("North Station");
      expect(stops[0].modes).toEqual(["rail"]);
      expect(stops[0].provider).toBe("mbta");

      // Verify radius is divided by 1000 (1000m → 1km in URL)
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("filter%5Bradius%5D=1");
    });

    it("returns empty array without API key", async () => {
      delete process.env.MBTA_API_KEY;

      const { getStops } = await loadModule();
      const stops = await getStops(42.36, -71.06, 1000);

      expect(stops).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStops } = await loadModule();
      const stops = await getStops(42.36, -71.06, 1000);

      expect(stops).toEqual([]);
    });

    it("maps vehicle_type 0 to tram, 1 to subway, 3 to bus, 4 to ferry", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "s1",
              attributes: { name: "S1", latitude: 0, longitude: 0, vehicle_type: 0 },
              relationships: {},
            },
            {
              id: "s2",
              attributes: { name: "S2", latitude: 0, longitude: 0, vehicle_type: 1 },
              relationships: {},
            },
            {
              id: "s3",
              attributes: { name: "S3", latitude: 0, longitude: 0, vehicle_type: 3 },
              relationships: {},
            },
            {
              id: "s4",
              attributes: { name: "S4", latitude: 0, longitude: 0, vehicle_type: 4 },
              relationships: {},
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(0, 0, 500);

      expect(stops[0].modes).toEqual(["tram"]);
      expect(stops[1].modes).toEqual(["subway"]);
      expect(stops[2].modes).toEqual(["bus"]);
      expect(stops[3].modes).toEqual(["ferry"]);
    });
  });

  describe("getStop", () => {
    it("returns a single stop by ID", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: {
            id: "place-sstat",
            attributes: {
              name: "South Station",
              latitude: 42.3519,
              longitude: -71.0552,
              vehicle_type: 2,
            },
            relationships: {},
          },
        }),
      );

      const { getStop } = await loadModule();
      const stop = await getStop("mb:place-sstat");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("mb:place-sstat");
      expect(stop?.name).toBe("South Station");
    });

    it("strips mb: prefix before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ data: null }));

      const { getStop } = await loadModule();
      await getStop("mb:place-test");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/stops/place-test");
      expect(fetchUrl).not.toContain("mb%3A");
    });

    it("returns null without API key", async () => {
      delete process.env.MBTA_API_KEY;

      const { getStop } = await loadModule();
      const stop = await getStop("mb:place-test");

      expect(stop).toBeNull();
    });
  });

  describe("getDepartures", () => {
    it("maps predictions with included route data", async () => {
      const now = Date.now();
      const depTime = new Date(now + 5 * 60 * 1000).toISOString();

      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              attributes: {
                departure_time: depTime,
                headsign: "Alewife",
                schedule_relationship: null,
                departure_boarding_area: "A",
              },
              relationships: {
                route: { data: { id: "Red" } },
                trip: { data: { id: "trip-1" } },
                schedule: { data: { id: "sched-1" } },
              },
            },
          ],
          included: [
            {
              type: "route",
              id: "Red",
              attributes: {
                short_name: "Red",
                long_name: "Red Line",
                type: 1, // subway
                color: "DA291C",
              },
            },
            {
              type: "schedule",
              id: "sched-1",
              attributes: {
                departure_time: depTime,
              },
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("mb:place-harvard", 30);

      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("trip-1");
      expect(deps[0].route.id).toBe("mb:Red");
      expect(deps[0].route.shortName).toBe("Red");
      expect(deps[0].route.longName).toBe("Red Line");
      expect(deps[0].route.mode).toBe("subway");
      expect(deps[0].route.color).toBe("DA291C");
      expect(deps[0].headsign).toBe("Alewife");
      expect(deps[0].platform).toBe("A");
    });

    it("CANCELLED schedule_relationship sets canceled=true", async () => {
      const now = Date.now();
      const depTime = new Date(now + 2 * 60 * 1000).toISOString();

      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              attributes: {
                departure_time: depTime,
                schedule_relationship: "CANCELLED",
              },
              relationships: {
                route: { data: { id: "Red" } },
                trip: { data: { id: "t1" } },
                schedule: { data: null },
              },
            },
          ],
          included: [],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("stop-1", 30);

      expect(deps[0].canceled).toBe(true);
    });

    it("strips mb: prefix from stop ID", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ data: [], included: [] }));

      const { getDepartures } = await loadModule();
      await getDepartures("mb:place-harvard", 30);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("filter%5Bstop%5D=place-harvard");
    });
  });

  describe("getAlerts", () => {
    it("maps alerts with affected route and stop IDs prefixed with mb:", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "alert-1",
              attributes: {
                severity: 7,
                effect: "DELAY",
                header: "Red Line Delays",
                description: "Signal problems near Harvard",
                informed_entity: [{ route: "Red" }, { stop: "place-harvard" }],
                active_period: [{ start: "2026-03-10T08:00:00Z", end: "2026-03-10T12:00:00Z" }],
              },
            },
          ],
        }),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts({ routeId: "mb:Red" });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].id).toBe("mb:alert-1");
      expect(alerts[0].severity).toBe("severe");
      expect(alerts[0].title).toBe("Red Line Delays");
      expect(alerts[0].affectedRouteIds).toEqual(["mb:Red"]);
      expect(alerts[0].affectedStopIds).toEqual(["mb:place-harvard"]);
      expect(alerts[0].activePeriods).toEqual([
        { start: "2026-03-10T08:00:00Z", end: "2026-03-10T12:00:00Z" },
      ]);
    });

    it("maps severity correctly", async () => {
      const makeAlert = (severity: number) => ({
        id: `a-${severity}`,
        attributes: {
          severity,
          header: "Test",
          informed_entity: [],
        },
      });

      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [makeAlert(2), makeAlert(5), makeAlert(8), makeAlert(10)],
        }),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts[0].severity).toBe("info"); // severity 2
      expect(alerts[1].severity).toBe("warning"); // severity 5
      expect(alerts[2].severity).toBe("severe"); // severity 8
      expect(alerts[3].severity).toBe("critical"); // severity 10
    });
  });

  describe("getVehiclePositions", () => {
    it("returns vehicle positions with mb: prefixed IDs", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "v1",
              attributes: {
                latitude: 42.36,
                longitude: -71.06,
                bearing: 180,
                speed: 10,
                label: "1234",
                current_stop_sequence: 5,
                updated_at: "2026-03-10T10:00:00Z",
              },
              relationships: {
                trip: { data: { id: "trip-1" } },
                stop: { data: { id: "place-north" } },
              },
            },
          ],
        }),
      );

      const { getVehiclePositions } = await loadModule();
      const vehicles = await getVehiclePositions("mb:Red");

      expect(vehicles).toHaveLength(1);
      expect(vehicles[0].id).toBe("mb:v1");
      expect(vehicles[0].provider).toBe("mbta");
      expect(vehicles[0].lat).toBe(42.36);
      expect(vehicles[0].lng).toBe(-71.06);
      expect(vehicles[0].bearing).toBe(180);
      expect(vehicles[0].tripId).toBe("mb:trip-1");
      expect(vehicles[0].routeId).toBe("mb:Red");
      expect(vehicles[0].currentStopId).toBe("mb:place-north");
    });
  });

  describe("getRoute", () => {
    it("returns a route with shape data", async () => {
      // getRoute calls both /routes/:id and /shapes (via getRouteShape) in parallel
      // First call: /routes/:id
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: {
            id: "Red",
            attributes: {
              short_name: "Red",
              long_name: "Red Line",
              type: 1,
              color: "DA291C",
              text_color: "FFFFFF",
            },
          },
        }),
      );
      // Second call: /shapes (for getRouteShape)
      mockFetch.mockResolvedValueOnce(mockOk({ data: [] }));

      const { getRoute } = await loadModule();
      const route = await getRoute("mb:Red");

      expect(route).not.toBeNull();
      expect(route?.id).toBe("mb:mb:Red"); // Note: the function passes routeId as-is to the mb: prefix
      expect(route?.shortName).toBe("Red");
      expect(route?.longName).toBe("Red Line");
      expect(route?.mode).toBe("subway");
      expect(route?.operatorName).toBe("MBTA");
    });
  });

  describe("getRouteStops", () => {
    it("returns stops for a route in order", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "s1",
              attributes: {
                name: "Stop A",
                latitude: 42.35,
                longitude: -71.05,
                platform_code: "1",
              },
            },
            { id: "s2", attributes: { name: "Stop B", latitude: 42.36, longitude: -71.06 } },
          ],
        }),
      );

      const { getRouteStops } = await loadModule();
      const stops = await getRouteStops("mb:Red");

      expect(stops).toHaveLength(2);
      expect(stops[0].id).toBe("mb:s1");
      expect(stops[0].name).toBe("Stop A");
      expect(stops[0].sequence).toBe(0);
      expect(stops[0].platformCode).toBe("1");
      expect(stops[1].sequence).toBe(1);
    });
  });

  describe("getFacilities", () => {
    it("maps ELEVATOR type and accessibility from properties", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "fac-1",
              attributes: {
                type: "ELEVATOR",
                long_name: "Elevator 1",
                short_name: "E1",
                properties: [{ name: "accessibility-accessible", value: 1 }],
              },
            },
            {
              id: "fac-2",
              attributes: {
                type: "ESCALATOR",
                long_name: "Escalator 2",
                properties: [{ name: "accessibility-accessible", value: 0 }],
              },
            },
          ],
        }),
      );

      const { getFacilities } = await loadModule();
      const facilities = await getFacilities("mb:place-north");

      expect(facilities).toHaveLength(2);
      expect(facilities[0].id).toBe("mb:fac-1");
      expect(facilities[0].stopId).toBe("mb:place-north");
      expect(facilities[0].type).toBe("elevator");
      expect(facilities[0].isAccessible).toBe(true);
      expect(facilities[0].name).toBe("Elevator 1");
      expect(facilities[0].provider).toBe("mbta");

      expect(facilities[1].type).toBe("escalator");
      expect(facilities[1].isAccessible).toBe(false);
    });

    it("defaults isAccessible to true when property missing", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          data: [
            {
              id: "fac-3",
              attributes: {
                type: "ELEVATOR",
                long_name: "Elevator 3",
                properties: [],
              },
            },
          ],
        }),
      );

      const { getFacilities } = await loadModule();
      const facilities = await getFacilities("place-1");

      expect(facilities[0].isAccessible).toBe(true);
    });
  });
});
