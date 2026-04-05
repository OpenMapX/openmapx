import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadModule() {
  return import("../opendata-ch.js");
}

describe("opendata-ch provider", () => {
  describe("getStops", () => {
    it("sends x=lat, y=lng (counterintuitive API swap)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [
            {
              id: "8503000",
              name: "Zurich HB",
              coordinate: { x: 47.3783, y: 8.5402 },
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(47.3783, 8.5402);

      // Verify the URL has x=lat, y=lng (swapped)
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("x=47.3783");
      expect(fetchUrl).toContain("y=8.5402");

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("ch:8503000");
      expect(stops[0].name).toBe("Zurich HB");
      // coordinate.x is lat, coordinate.y is lng
      expect(stops[0].lat).toBe(47.3783);
      expect(stops[0].lng).toBe(8.5402);
      expect(stops[0].modes).toEqual(["rail"]);
      expect(stops[0].provider).toBe("opendata-ch");
    });

    it("filters out stations without valid coordinates", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [
            { id: "valid", name: "Valid", coordinate: { x: 47.3, y: 8.5 } },
            { id: "no-coord", name: "No Coord", coordinate: { x: null, y: null } },
            { id: null, name: "No ID", coordinate: { x: 47.0, y: 8.0 } },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(47.0, 8.0);

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("ch:valid");
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStops } = await loadModule();
      const stops = await getStops(47.0, 8.0);

      expect(stops).toEqual([]);
    });
  });

  describe("searchByName", () => {
    it("searches stations by query string", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [
            { id: "8503000", name: "Zurich HB", coordinate: { x: 47.3783, y: 8.5402 } },
            { id: "8503001", name: "Zurich Oerlikon", coordinate: { x: 47.4115, y: 8.5443 } },
          ],
        }),
      );

      const { searchByName } = await loadModule();
      const results = await searchByName("Zurich", 10);

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("Zurich HB");
    });

    it("respects limit parameter", async () => {
      const stations = Array.from({ length: 20 }, (_, i) => ({
        id: `${8503000 + i}`,
        name: `Station ${i}`,
        coordinate: { x: 47.0 + i * 0.01, y: 8.0 + i * 0.01 },
      }));
      mockFetch.mockResolvedValueOnce(mockOk({ stations }));

      const { searchByName } = await loadModule();
      const results = await searchByName("Station", 5);

      expect(results).toHaveLength(5);
    });
  });

  describe("getDepartures", () => {
    it("maps delay in minutes to seconds (5min delay = 300s)", async () => {
      const now = new Date();
      const depTime = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stationboard: [
            {
              number: "IC 123",
              name: "IC 123",
              category: "IC",
              to: "Bern",
              stop: {
                departure: depTime,
                delay: 5, // 5 minutes
                platform: "7",
              },
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("ch:8503000", 30);

      expect(deps).toHaveLength(1);
      expect(deps[0].delaySeconds).toBe(300); // 5 * 60
      expect(deps[0].expectedAt).toBeDefined();
      expect(deps[0].route.mode).toBe("rail"); // IC → rail
      expect(deps[0].route.id).toBe("ch:IC 123");
      expect(deps[0].headsign).toBe("Bern");
      expect(deps[0].platform).toBe("7");
    });

    it("maps category to transport modes correctly", async () => {
      const now = new Date();
      const depTime = new Date(now.getTime() + 2 * 60 * 1000).toISOString();

      const makeEntry = (category: string) => ({
        number: category,
        name: category,
        category,
        to: "Destination",
        stop: { departure: depTime, delay: 0 },
      });

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stationboard: [
            makeEntry("IC"),
            makeEntry("B"),
            makeEntry("T"),
            makeEntry("BAT"),
            makeEntry("FUN"),
            makeEntry("SL"),
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("ch:8503000", 30);

      expect(deps[0].route.mode).toBe("rail"); // IC
      expect(deps[1].route.mode).toBe("bus"); // B
      expect(deps[2].route.mode).toBe("tram"); // T
      expect(deps[3].route.mode).toBe("ferry"); // BAT
      expect(deps[4].route.mode).toBe("funicular"); // FUN
      expect(deps[5].route.mode).toBe("cable_car"); // SL
    });

    it("strips ch: prefix before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stationboard: [] }));

      const { getDepartures } = await loadModule();
      await getDepartures("ch:8503000", 30);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("station=8503000");
      expect(fetchUrl).not.toContain("ch%3A");
    });

    it("does not set delaySeconds when delay is 0", async () => {
      const depTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stationboard: [
            {
              number: "S1",
              name: "S1",
              category: "S",
              to: "Destination",
              stop: { departure: depTime, delay: 0 },
            },
          ],
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("ch:8503000", 30);

      expect(deps[0].delaySeconds).toBeUndefined();
      expect(deps[0].expectedAt).toBeUndefined();
    });
  });

  describe("getArrivals", () => {
    it("fetches arrivals with arrdep=arrival", async () => {
      const arrTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      mockFetch.mockResolvedValueOnce(
        mockOk({
          stationboard: [
            {
              number: "IC 456",
              name: "IC 456",
              category: "IC",
              from: "Geneva",
              stop: { arrival: arrTime, delay: 0 },
            },
          ],
        }),
      );

      const { getArrivals } = await loadModule();
      const arrivals = await getArrivals("ch:8503000", 30);

      expect(arrivals).toHaveLength(1);
      expect(arrivals[0].headsign).toBe("Geneva"); // uses "from" for arrivals

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("arrdep=arrival");
    });
  });

  describe("planConnections", () => {
    it("parses 00d00:57:00 duration format to seconds", async () => {
      // First two calls: findNearestStation (from + to) in parallel
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [{ id: "8503000", name: "Zurich HB", coordinate: { x: 47.3783, y: 8.5402 } }],
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [{ id: "8507000", name: "Bern", coordinate: { x: 46.949, y: 7.439 } }],
        }),
      );

      // Third call: connections API
      mockFetch.mockResolvedValueOnce(
        mockOk({
          connections: [
            {
              duration: "00d00:57:00",
              from: { departure: "2026-03-10T10:00:00Z" },
              to: { arrival: "2026-03-10T10:57:00Z" },
              transfers: 0,
              legs: [
                {
                  departure: "2026-03-10T10:00:00Z",
                  arrival: "2026-03-10T10:57:00Z",
                  journey: { category: "IC", name: "IC 1" },
                  from: {
                    station: {
                      id: "8503000",
                      name: "Zurich HB",
                      coordinate: { x: 47.3783, y: 8.5402 },
                    },
                  },
                  to: {
                    station: {
                      id: "8507000",
                      name: "Bern",
                      coordinate: { x: 46.949, y: 7.439 },
                    },
                  },
                },
              ],
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(47.3783, 8.5402, 46.949, 7.439, "2026-03-10", "10:00");

      expect(plan).not.toBeNull();
      if (!plan) throw new Error("plan was null");
      expect(plan.from.name).toBe("Zurich HB");
      expect(plan.to.name).toBe("Bern");
      // coordinate.x is lat — verify the TripPlan uses x for lat
      expect(plan.from.lat).toBe(47.3783);
      expect(plan.from.lng).toBe(8.5402);

      expect(plan.itineraries).toHaveLength(1);
      const itin = plan.itineraries[0];
      if (!itin) throw new Error("itin was undefined");
      // "00d00:57:00" → 57 * 60 = 3420 seconds
      expect(itin.duration).toBe(3420);
      expect(itin.transfers).toBe(0);
      expect(itin.legs).toHaveLength(1);
      expect(itin.legs[0].mode).toBe("rail"); // IC → rail
      expect(itin.legs[0].from.stopId).toBe("ch:8503000");
      expect(itin.legs[0].to.stopId).toBe("ch:8507000");
      expect(itin.legs[0].route?.shortName).toBe("IC 1");
    });

    it("handles walk legs", async () => {
      // Station lookups
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [{ id: "8503000", name: "Zurich HB", coordinate: { x: 47.3783, y: 8.5402 } }],
        }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stations: [{ id: "8507000", name: "Bern", coordinate: { x: 46.949, y: 7.439 } }],
        }),
      );

      mockFetch.mockResolvedValueOnce(
        mockOk({
          connections: [
            {
              duration: "00d01:10:00",
              from: { departure: "2026-03-10T10:00:00Z" },
              to: { arrival: "2026-03-10T11:10:00Z" },
              transfers: 0,
              legs: [
                {
                  departure: "2026-03-10T10:00:00Z",
                  arrival: "2026-03-10T10:05:00Z",
                  walk: 1,
                  from: {
                    station: {
                      id: "8503000",
                      name: "Zurich HB",
                      coordinate: { x: 47.3783, y: 8.5402 },
                    },
                  },
                  to: {
                    station: {
                      id: "8503001",
                      name: "Zurich HB (platform)",
                      coordinate: { x: 47.3784, y: 8.5403 },
                    },
                  },
                },
              ],
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(47.3783, 8.5402, 46.949, 7.439, "2026-03-10", "10:00");

      expect(plan).not.toBeNull();
      expect(plan?.itineraries[0].legs[0].mode).toBe("walking");
      expect(plan?.itineraries[0].legs[0].route).toBeUndefined();
    });

    it("returns null when no station found", async () => {
      // Both station lookups return empty
      mockFetch.mockResolvedValueOnce(mockOk({ stations: [] }));
      mockFetch.mockResolvedValueOnce(mockOk({ stations: [] }));

      const { planConnections } = await loadModule();
      const plan = await planConnections(0, 0, 1, 1, "2026-03-10", "10:00");

      expect(plan).toBeNull();
    });

    it("returns null on connections API failure", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({ stations: [{ id: "1", name: "A", coordinate: { x: 47.0, y: 8.0 } }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({ stations: [{ id: "2", name: "B", coordinate: { x: 46.0, y: 7.0 } }] }),
      );
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { planConnections } = await loadModule();
      const plan = await planConnections(47.0, 8.0, 46.0, 7.0, "2026-03-10", "10:00");

      expect(plan).toBeNull();
    });

    it("parses duration with hours correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({ stations: [{ id: "1", name: "A", coordinate: { x: 47.0, y: 8.0 } }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({ stations: [{ id: "2", name: "B", coordinate: { x: 46.0, y: 7.0 } }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockOk({
          connections: [
            {
              duration: "00d02:15:30",
              from: { departure: "2026-03-10T10:00:00Z" },
              to: { arrival: "2026-03-10T12:15:30Z" },
              transfers: 1,
              legs: [],
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(47.0, 8.0, 46.0, 7.0, "2026-03-10", "10:00");

      expect(plan).not.toBeNull();
      // 2h * 3600 + 15m * 60 + 30s = 7200 + 900 + 30 = 8130
      expect(plan?.itineraries[0].duration).toBe(8130);
    });
  });
});
