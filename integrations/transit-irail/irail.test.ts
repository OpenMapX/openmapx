import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

// iRail has module-level stationsCache. We use vi.resetModules() + dynamic import
// to get a fresh module each test.
beforeEach(() => {
  vi.resetModules();
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

const SAMPLE_STATIONS = [
  {
    id: "BE.NMBS.008814001",
    name: "Brussels-South",
    locationX: "4.336531",
    locationY: "50.835707",
  },
  { id: "BE.NMBS.008821006", name: "Leuven", locationX: "4.71566", locationY: "50.88143" },
  {
    id: "BE.NMBS.008891009",
    name: "Antwerpen-Centraal",
    locationX: "4.421101",
    locationY: "51.2172",
  },
];

function mockStationsResponse() {
  mockFetch.mockResolvedValueOnce(mockOk({ station: SAMPLE_STATIONS }));
}

async function loadModule() {
  return import("./provider.js");
}

describe("irail provider", () => {
  describe("getStops", () => {
    it("filters by distance and returns ir: prefixed stops with mode=rail", async () => {
      mockStationsResponse();

      const { getStops } = await loadModule();
      // Brussels-South is at (50.835707, 4.336531)
      // Use a narrow area around Brussels-South
      const stops = await getStops(50.835, 4.336, 5000);

      expect(stops.length).toBeGreaterThanOrEqual(1);
      const bxl = stops.find((s) => s.id === "ir:BE.NMBS.008814001");
      expect(bxl).toBeDefined();
      expect(bxl?.name).toBe("Brussels-South");
      expect(bxl?.lat).toBeCloseTo(50.835707);
      expect(bxl?.lng).toBeCloseTo(4.336531);
      expect(bxl?.modes).toEqual(["rail"]);
      expect(bxl?.provider).toBe("irail");
    });

    it("populates station cache on first call", async () => {
      mockStationsResponse();

      const { getStops } = await loadModule();
      await getStops(50.8, 4.3, 100000);

      // First call should fetch stations
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/stations/");
    });

    it("uses cache on second call", async () => {
      mockStationsResponse();

      const mod = await loadModule();
      await mod.getStops(50.8, 4.3, 100000);
      await mod.getStops(51.0, 4.4, 100000);

      // Should only fetch once — cache is used for second call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStopById", () => {
    it("returns stop by ID from cached stations", async () => {
      mockStationsResponse();

      const { getStopById } = await loadModule();
      const stop = await getStopById("ir:BE.NMBS.008814001");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("ir:BE.NMBS.008814001");
      expect(stop?.name).toBe("Brussels-South");
    });

    it("returns null for unknown ID", async () => {
      mockStationsResponse();

      const { getStopById } = await loadModule();
      const stop = await getStopById("ir:UNKNOWN");

      expect(stop).toBeNull();
    });
  });

  describe("searchByName", () => {
    it("filters stations by name substring", async () => {
      mockStationsResponse();

      const { searchByName } = await loadModule();
      const results = await searchByName("Brussels");

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Brussels-South");
    });

    it("is case-insensitive", async () => {
      mockStationsResponse();

      const { searchByName } = await loadModule();
      const results = await searchByName("LEUVEN");

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Leuven");
    });
  });

  describe("getDepartures", () => {
    it("maps delay in seconds and canceled flag", async () => {
      // First call: getAllStations (for the cache — getDepartures doesn't call it but just in case)
      // Actually getDepartures calls fetchLiveboard directly, no station fetch needed

      const epochSeconds = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

      mockFetch.mockResolvedValueOnce(
        mockOk({
          departures: {
            departure: [
              {
                time: String(epochSeconds),
                delay: "120", // 120 seconds
                vehicle: "BE.NMBS.IC1234",
                vehicleinfo: { shortname: "IC 1234" },
                station: "Antwerpen-Centraal",
                stationinfo: { name: "Antwerpen-Centraal" },
                platforminfo: { name: "3" },
                canceled: "0",
                occupancy: { name: "low" },
              },
              {
                time: String(epochSeconds + 60),
                delay: "0",
                vehicle: "BE.NMBS.IC5678",
                station: "Brussels-South",
                stationinfo: { name: "Brussels-South" },
                canceled: "1",
              },
            ],
          },
        }),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("ir:BE.NMBS.008814001", 30);

      expect(deps).toHaveLength(2);

      // First departure: 120s delay
      expect(deps[0].delaySeconds).toBe(120);
      expect(deps[0].expectedAt).toBeDefined();
      expect(deps[0].platform).toBe("3");
      expect(deps[0].canceled).toBe(false);
      expect(deps[0].occupancy).toBe("low");
      expect(deps[0].route.mode).toBe("rail");
      expect(deps[0].route.id).toBe("ir:BE.NMBS.IC1234");

      // Second departure: canceled
      expect(deps[1].canceled).toBe(true);
      expect(deps[1].delaySeconds).toBeUndefined();
    });

    it("strips ir: prefix before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ departures: { departure: [] } }));

      const { getDepartures } = await loadModule();
      await getDepartures("ir:BE.NMBS.008814001", 30);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("id=BE.NMBS.008814001");
      expect(fetchUrl).not.toContain("ir%3A");
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("stop-1", 30);

      expect(deps).toEqual([]);
    });
  });

  describe("getArrivals", () => {
    it("fetches arrivals with arrdep=arrival", async () => {
      const epochSeconds = Math.floor(Date.now() / 1000) + 300;

      mockFetch.mockResolvedValueOnce(
        mockOk({
          arrivals: {
            arrival: [
              {
                time: String(epochSeconds),
                delay: "0",
                vehicle: "BE.NMBS.IC9999",
                station: "Brussels-South",
                stationinfo: { name: "Brussels-South" },
                canceled: "0",
              },
            ],
          },
        }),
      );

      const { getArrivals } = await loadModule();
      const arrivals = await getArrivals("ir:BE.NMBS.008814001", 30);

      expect(arrivals).toHaveLength(1);

      // Verify arrdep=arrival was sent
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("arrdep=arrival");
    });
  });

  describe("getVehicleJourney", () => {
    it("strips ir: prefix and returns journey with stops", async () => {
      const depTime = Math.floor(Date.now() / 1000) + 600;
      const arrTime = depTime - 120;

      mockFetch.mockResolvedValueOnce(
        mockOk({
          vehicle: "BE.NMBS.IC1234",
          stops: {
            stop: [
              {
                station: "Brussels-South",
                stationinfo: {
                  id: "BE.NMBS.008814001",
                  name: "Brussels-South",
                  locationX: "4.336531",
                  locationY: "50.835707",
                },
                scheduledDepartureTime: String(depTime),
                scheduledArrivalTime: String(arrTime),
                delay: "60",
                platforminfo: { name: "5" },
                canceled: "0",
                left: "1",
              },
            ],
          },
          occupancy: { name: "medium" },
        }),
      );

      const { getVehicleJourney } = await loadModule();
      const journey = await getVehicleJourney("ir:BE.NMBS.IC1234");

      // Verify ir: prefix stripped from API call
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("id=BE.NMBS.IC1234");
      expect(fetchUrl).not.toContain("ir%3A");

      expect(journey).not.toBeNull();
      if (!journey) throw new Error("journey was null");
      expect(journey.id).toBe("ir:BE.NMBS.IC1234");
      expect(journey.name).toBe("BE.NMBS.IC1234");
      expect(journey.provider).toBe("irail");
      expect(journey.occupancy).toBe("medium");
      expect(journey.stops).toHaveLength(1);

      const stop = journey.stops[0];
      if (!stop) throw new Error("stop was undefined");
      expect(stop.stopId).toBe("ir:BE.NMBS.008814001");
      expect(stop.name).toBe("Brussels-South");
      expect(stop.platform).toBe("5");
      expect(stop.delaySeconds).toBe(60);
      expect(stop.departed).toBe(true);
      expect(stop.canceled).toBe(false);
      // Expected times should include the delay
      expect(stop.expectedDeparture).toBeDefined();
      expect(stop.expectedArrival).toBeDefined();
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getVehicleJourney } = await loadModule();
      const journey = await getVehicleJourney("ir:test");

      expect(journey).toBeNull();
    });
  });

  describe("planConnections", () => {
    it("finds nearest stations and returns trip plan", async () => {
      // First call: getAllStations
      mockStationsResponse();

      const depEpoch = Math.floor(new Date("2026-03-10T10:00:00Z").getTime() / 1000);
      const arrEpoch = Math.floor(new Date("2026-03-10T10:57:00Z").getTime() / 1000);

      // Second call: connections API
      mockFetch.mockResolvedValueOnce(
        mockOk({
          connection: [
            {
              duration: 3420,
              departure: {
                time: String(depEpoch),
                stationinfo: { locationY: "50.835707", locationX: "4.336531" },
                vehicle: "BE.NMBS.IC1234",
              },
              arrival: {
                time: String(arrEpoch),
                stationinfo: { locationY: "50.88143", locationX: "4.71566" },
              },
              vias: { number: "0" },
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(
        50.835,
        4.336, // near Brussels-South
        50.881,
        4.715, // near Leuven
        "2026-03-10",
        "10:00",
      );

      expect(plan).not.toBeNull();
      if (!plan) throw new Error("plan was null");
      expect(plan.from.name).toBe("Brussels-South");
      expect(plan.to.name).toBe("Leuven");
      expect(plan.itineraries).toHaveLength(1);

      const itin = plan.itineraries[0];
      if (!itin) throw new Error("itin was undefined");
      expect(itin.duration).toBe(3420);
      expect(itin.transfers).toBe(0);
      expect(itin.legs).toHaveLength(1);
      expect(itin.legs[0].mode).toBe("rail");
    });

    it("builds multi-leg itinerary when vias are present", async () => {
      // First call: getAllStations
      mockStationsResponse();

      const depEpoch = Math.floor(new Date("2026-03-10T10:00:00Z").getTime() / 1000);
      const viaArrEpoch = depEpoch + 1200; // 20 min later
      const viaDepEpoch = viaArrEpoch + 120; // 2 min transfer
      const arrEpoch = viaDepEpoch + 1800; // 30 min later

      // Second call: connections API with via
      mockFetch.mockResolvedValueOnce(
        mockOk({
          connection: [
            {
              duration: 3120,
              departure: {
                time: String(depEpoch),
                stationinfo: { locationY: "50.835707", locationX: "4.336531" },
                vehicle: "BE.NMBS.IC1234",
              },
              arrival: {
                time: String(arrEpoch),
                stationinfo: { locationY: "51.2172", locationX: "4.421101" },
              },
              vias: {
                number: "1",
                via: [
                  {
                    station: "Leuven",
                    stationinfo: {
                      id: "BE.NMBS.008821006",
                      locationY: "50.88143",
                      locationX: "4.71566",
                    },
                    arrival: { time: String(viaArrEpoch) },
                    departure: { time: String(viaDepEpoch), vehicle: "BE.NMBS.IC5678" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(50.835, 4.336, 51.217, 4.421, "2026-03-10", "10:00");

      expect(plan).not.toBeNull();
      if (!plan) throw new Error("plan was null");
      expect(plan.itineraries).toHaveLength(1);

      const itin = plan.itineraries[0];
      if (!itin) throw new Error("itin was undefined");
      expect(itin.transfers).toBe(1); // One via = one transfer
      expect(itin.legs).toHaveLength(2); // Brussels -> Leuven, Leuven -> Antwerpen

      // First leg: origin -> via
      expect(itin.legs[0].from.name).toBe("Brussels-South");
      expect(itin.legs[0].to.name).toBe("Leuven");

      // Second leg: via -> destination
      expect(itin.legs[1].from.name).toBe("Leuven");
    });

    it("builds legs through multiple vias", async () => {
      mockStationsResponse();

      const depEpoch = Math.floor(new Date("2026-03-10T10:00:00Z").getTime() / 1000);
      const via1Arr = depEpoch + 1200;
      const via1Dep = via1Arr + 120;
      const via2Arr = via1Dep + 600;
      const via2Dep = via2Arr + 120;
      const arrEpoch = via2Dep + 600;

      mockFetch.mockResolvedValueOnce(
        mockOk({
          connection: [
            {
              duration: 3660,
              departure: {
                time: String(depEpoch),
                stationinfo: { locationY: "50.835707", locationX: "4.336531" },
                vehicle: "BE.NMBS.IC1234",
              },
              arrival: {
                time: String(arrEpoch),
                stationinfo: { locationY: "51.2172", locationX: "4.421101" },
              },
              vias: {
                number: "2",
                via: [
                  {
                    station: "Leuven",
                    stationinfo: {
                      id: "BE.NMBS.008821006",
                      locationY: "50.88143",
                      locationX: "4.71566",
                    },
                    arrival: { time: String(via1Arr) },
                    departure: { time: String(via1Dep), vehicle: "BE.NMBS.IC2222" },
                  },
                  {
                    station: "Mechelen",
                    stationinfo: {
                      id: "BE.NMBS.008821001",
                      locationY: "51.0175",
                      locationX: "4.4832",
                    },
                    arrival: { time: String(via2Arr) },
                    departure: { time: String(via2Dep), vehicle: "BE.NMBS.IC3333" },
                  },
                ],
              },
            },
          ],
        }),
      );

      const { planConnections } = await loadModule();
      const plan = await planConnections(50.835, 4.336, 51.217, 4.421, "2026-03-10", "10:00");

      expect(plan).not.toBeNull();
      if (!plan) throw new Error("plan was null");
      const itin = plan.itineraries[0];
      if (!itin) throw new Error("itin was undefined");
      expect(itin.transfers).toBe(2);
      expect(itin.legs).toHaveLength(3); // origin -> via1, via1 -> via2, via2 -> dest
    });

    it("returns null on fetch error", async () => {
      mockStationsResponse();
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { planConnections } = await loadModule();
      const plan = await planConnections(50.835, 4.336, 50.881, 4.715, "2026-03-10", "10:00");

      expect(plan).toBeNull();
    });

    it("returns null when no stations available", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ station: [] }));

      const { planConnections } = await loadModule();
      const plan = await planConnections(0, 0, 1, 1, "2026-03-10", "10:00");

      expect(plan).toBeNull();
    });
  });
});
