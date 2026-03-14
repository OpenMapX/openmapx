import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch — transitous.ts uses motisFetch which calls global fetch internally
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk() {
  return { ok: false, status: 500 } as Response;
}

// Dynamic import to pick up the stubbed fetch
async function loadModule() {
  return import("../transitous.js");
}

describe("transitous provider", () => {
  describe("getStops", () => {
    it("returns stops with mo: prefix and mapped modes", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            stopId: "de:09162:1",
            name: "Hauptbahnhof",
            lat: 48.14,
            lon: 11.56,
            modes: ["RAIL", "SUBWAY"],
          },
          {
            stopId: "de:09162:2",
            name: "Marienplatz",
            lat: 48.137,
            lon: 11.576,
            modes: ["SUBWAY"],
          },
        ]),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([11.5, 48.1, 11.6, 48.2]);

      expect(stops).toHaveLength(2);
      expect(stops[0].id).toBe("mo:de:09162:1");
      expect(stops[0].name).toBe("Hauptbahnhof");
      expect(stops[0].lat).toBe(48.14);
      expect(stops[0].lng).toBe(11.56);
      expect(stops[0].modes).toContain("rail");
      expect(stops[0].modes).toContain("subway");
      expect(stops[0].provider).toBe("transitous");

      expect(stops[1].id).toBe("mo:de:09162:2");
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
  });

  describe("getDepartures", () => {
    it("strips mo: prefix before API call and maps departures", async () => {
      const scheduledDep = "2026-03-10T10:00:00Z";
      const actualDep = "2026-03-10T10:03:00Z";

      mockFetch.mockResolvedValueOnce(
        mockOk({
          place: { stopId: "de:09162:1", name: "Hauptbahnhof" },
          stopTimes: [
            {
              tripId: "trip123",
              routeId: "route-A",
              displayName: "S1",
              mode: "RAIL",
              headsign: "Airport",
              realTime: true,
              routeColor: "#00FF00",
              place: {
                scheduledDeparture: scheduledDep,
                departure: actualDep,
                track: "3",
              },
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("mo:de:09162:1", 30);

      // Verify the fetch URL does not contain the mo: prefix in the stopId param
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("stopId=de%3A09162%3A1");
      expect(fetchUrl).not.toContain("mo%3A");

      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("mo:trip123");
      expect(deps[0].route.id).toBe("mo:route-A");
      expect(deps[0].route.shortName).toBe("S1");
      expect(deps[0].route.mode).toBe("rail");
      expect(deps[0].route.color).toBe("00FF00");
      expect(deps[0].headsign).toBe("Airport");
      expect(deps[0].scheduledAt).toBe(scheduledDep);
      expect(deps[0].expectedAt).toBe(actualDep);
      // 3 minutes delay = 180 seconds
      expect(deps[0].delaySeconds).toBe(180);
      expect(deps[0].platform).toBe("3");
    });

    it("returns empty array when stopTimes missing", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ place: {} }));

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("stop1", 30);

      expect(deps).toEqual([]);
    });

    it("sets canceled from cancelled or tripCancelled", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopTimes: [
            {
              tripId: "t1",
              cancelled: true,
              mode: "BUS",
              place: { scheduledDeparture: "2026-03-10T10:00:00Z" },
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("stop1", 30);

      expect(deps[0].canceled).toBe(true);
    });
  });

  describe("getArrivals", () => {
    it("uses arrival timestamps (not departure)", async () => {
      const scheduledArr = "2026-03-10T10:30:00Z";

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopTimes: [
            {
              tripId: "t1",
              mode: "RAIL",
              place: {
                scheduledArrival: scheduledArr,
                scheduledDeparture: "2026-03-10T10:35:00Z",
              },
            },
          ],
        }),
      );

      const { getArrivals } = await loadModule();
      const arrivals = await getArrivals("stop1", 60);

      // Should use arrival, not departure
      expect(arrivals[0].scheduledAt).toBe(scheduledArr);

      // Verify arriveBy=true was sent in the URL
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("arriveBy=true");
    });
  });

  describe("searchByName", () => {
    it("filters to STOP/STATION types only", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          { type: "STOP", stopId: "s1", name: "Stop One", lat: 48.1, lon: 11.5, modes: ["BUS"] },
          {
            type: "STATION",
            stopId: "s2",
            name: "Station Two",
            lat: 48.2,
            lon: 11.6,
            modes: ["RAIL"],
          },
          { type: "ADDRESS", name: "Some Address", lat: 48.3, lon: 11.7 },
          { type: "STOP", name: "No Stop ID", lat: 48.4, lon: 11.8, modes: ["BUS"] },
        ]),
      );

      const { searchByName } = await loadModule();
      const results = await searchByName("test");

      // Only STOP/STATION with stopId should pass
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("mo:s1");
      expect(results[1].id).toBe("mo:s2");
    });

    it("respects the limit parameter", async () => {
      const stops = Array.from({ length: 20 }, (_, i) => ({
        type: "STOP",
        stopId: `s${i}`,
        name: `Stop ${i}`,
        lat: 48,
        lon: 11,
        modes: ["BUS"],
      }));
      mockFetch.mockResolvedValueOnce(mockOk(stops));

      const { searchByName } = await loadModule();
      const results = await searchByName("test", 5);

      expect(results).toHaveLength(5);
    });
  });

  describe("getStopById", () => {
    it("returns a normalized stop from the place field", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          place: {
            stopId: "de:09162:1",
            name: "Hauptbahnhof",
            lat: 48.14,
            lon: 11.56,
            modes: ["RAIL"],
          },
        }),
      );

      const { getStopById } = await loadModule();
      const stop = await getStopById("mo:de:09162:1");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("mo:de:09162:1");
      expect(stop?.name).toBe("Hauptbahnhof");
      expect(stop?.provider).toBe("transitous");
    });

    it("returns null when place has no stopId (data.place is falsy)", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ place: null }));

      const { getStopById } = await loadModule();
      const stop = await getStopById("mo:nonexistent");

      expect(stop).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStopById } = await loadModule();
      const stop = await getStopById("mo:missing");

      expect(stop).toBeNull();
    });
  });

  describe("planTrip", () => {
    it("returns itineraries with prefixed stop IDs on success", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          from: { name: "Origin", lat: 48.1, lon: 11.5 },
          to: { name: "Destination", lat: 48.2, lon: 11.6 },
          itineraries: [
            {
              duration: 1800,
              transfers: 1,
              legs: [
                {
                  mode: "WALK",
                  startTime: "2026-03-10T09:00:00Z",
                  endTime: "2026-03-10T09:05:00Z",
                  from: { name: "Origin", lat: 48.1, lon: 11.5 },
                  to: { name: "Stop A", lat: 48.12, lon: 11.52, stopId: "s1" },
                  distance: 300,
                },
                {
                  mode: "RAIL",
                  startTime: "2026-03-10T09:10:00Z",
                  endTime: "2026-03-10T09:25:00Z",
                  from: { name: "Stop A", lat: 48.12, lon: 11.52, stopId: "s1" },
                  to: { name: "Stop B", lat: 48.18, lon: 11.58, stopId: "s2" },
                  routeShortName: "S1",
                  routeLongName: "S-Bahn 1",
                  routeId: "r1",
                  tripId: "trip1",
                  intermediateStops: [{}, {}],
                },
              ],
            },
          ],
        }),
      );

      const { planTrip } = await loadModule();
      const plan = await planTrip(48.1, 11.5, 48.2, 11.6, "2026-03-10", "09:00");

      expect(plan).not.toBeNull();
      if (!plan) throw new Error("plan was null");
      expect(plan.from.name).toBe("Origin");
      expect(plan.to.name).toBe("Destination");
      expect(plan.itineraries).toHaveLength(1);

      const itin = plan.itineraries[0];
      if (!itin) throw new Error("itin was undefined");
      expect(itin.duration).toBe(1800);
      expect(itin.transfers).toBe(1);
      expect(itin.walkDistance).toBe(300);
      expect(itin.legs).toHaveLength(2);

      // Walk leg
      expect(itin.legs[0].mode).toBe("walking");
      expect(itin.legs[0].route).toBeUndefined();

      // Transit leg
      expect(itin.legs[1].mode).toBe("rail");
      expect(itin.legs[1].from.stopId).toBe("mo:s1");
      expect(itin.legs[1].to.stopId).toBe("mo:s2");
      expect(itin.legs[1].route?.shortName).toBe("S1");
      expect(itin.legs[1].tripId).toBe("mo:trip1");
      expect(itin.legs[1]._intermediateStopCount).toBe(2);
    });

    it("returns null on failure", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { planTrip } = await loadModule();
      const plan = await planTrip(48.1, 11.5, 48.2, 11.6, "2026-03-10", "09:00");

      expect(plan).toBeNull();
    });

    it("returns null when no itineraries", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ itineraries: [] }));

      const { planTrip } = await loadModule();
      const plan = await planTrip(48.1, 11.5, 48.2, 11.6, "2026-03-10", "09:00");

      expect(plan).toBeNull();
    });
  });

  describe("getVehicleRadar", () => {
    it("returns vehicle positions from trip segments", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            trips: [{ tripId: "trip-abc", displayName: "S1 Airport" }],
            from: { lat: 48.14, lon: 11.56, stopId: "stop-1" },
            departure: "2026-03-10T10:00:00Z",
          },
          {
            trips: [{ tripId: "trip-def" }],
            from: { lat: 48.15, lon: 11.57 },
            departure: "2026-03-10T10:02:00Z",
          },
        ]),
      );

      const { getVehicleRadar } = await loadModule();
      const vehicles = await getVehicleRadar([11.5, 48.1, 11.6, 48.2]);

      expect(vehicles).toHaveLength(2);
      expect(vehicles[0].id).toBe("mo:trip-abc");
      expect(vehicles[0].provider).toBe("transitous");
      expect(vehicles[0].tripId).toBe("mo:trip-abc");
      expect(vehicles[0].lat).toBe(48.14);
      expect(vehicles[0].lng).toBe(11.56);
      expect(vehicles[0].label).toBe("S1 Airport");
      expect(vehicles[0].currentStopId).toBe("mo:stop-1");
      expect(vehicles[0].updatedAt).toBe("2026-03-10T10:00:00Z");

      // Second vehicle has no displayName → label undefined
      expect(vehicles[1].label).toBeUndefined();
    });

    it("filters out segments with no lat/lon", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          { trips: [{}], from: {} },
          { trips: [{ tripId: "t1" }], from: { lat: 48.1, lon: 11.5 } },
        ]),
      );

      const { getVehicleRadar } = await loadModule();
      const vehicles = await getVehicleRadar([11.0, 48.0, 12.0, 49.0]);

      expect(vehicles).toHaveLength(1);
    });

    it("returns empty array on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      const { getVehicleRadar } = await loadModule();
      const vehicles = await getVehicleRadar([0, 0, 1, 1]);

      expect(vehicles).toEqual([]);
    });
  });
});
