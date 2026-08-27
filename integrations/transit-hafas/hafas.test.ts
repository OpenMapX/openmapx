import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HafasInstance } from "./provider.js";

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
  return Response.json(data);
}

function mockNotOk() {
  return { ok: false, status: 500 } as Response;
}

async function loadModule() {
  return import("./provider.js");
}

// Constants

describe("HAFAS_INSTANCES", () => {
  it("has db, vbb, bvg instances", async () => {
    const { HAFAS_INSTANCES } = await loadModule();
    const ids = HAFAS_INSTANCES.map((i) => i.id);
    expect(ids).toContain("db");
    expect(ids).toContain("vbb");
    expect(ids).toContain("bvg");
  });

  it("vbb and bvg have hasRadar=true; db has hasRadar=false", async () => {
    const { HAFAS_INSTANCES } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db");
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb");
    const bvg = HAFAS_INSTANCES.find((i) => i.id === "bvg");

    expect(db?.hasRadar).toBe(false);
    expect(vbb?.hasRadar).toBe(true);
    expect(bvg?.hasRadar).toBe(true);
  });

  it("each instance has the correct prefix", async () => {
    const { HAFAS_INSTANCES } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db");
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb");
    const bvg = HAFAS_INSTANCES.find((i) => i.id === "bvg");

    expect(db?.prefix).toBe("db-hafas:");
    expect(vbb?.prefix).toBe("vbb:");
    expect(bvg?.prefix).toBe("bvg:");
  });
});

// instanceFromPrefix

describe("instanceFromPrefix", () => {
  it('returns vbb instance for "vbb:900000009102"', async () => {
    const { instanceFromPrefix } = await loadModule();
    const inst = instanceFromPrefix("vbb:900000009102");
    expect(inst).not.toBeNull();
    expect(inst?.id).toBe("vbb");
  });

  it('returns db instance for "db-hafas:8000105"', async () => {
    const { instanceFromPrefix } = await loadModule();
    const inst = instanceFromPrefix("db-hafas:8000105");
    expect(inst).not.toBeNull();
    expect(inst?.id).toBe("db");
  });

  it('returns null for "unknown:foo"', async () => {
    const { instanceFromPrefix } = await loadModule();
    const inst = instanceFromPrefix("unknown:foo");
    expect(inst).toBeNull();
  });
});

// getRadarInstances

describe("getRadarInstances", () => {
  it("Berlin bbox returns instances with hasRadar=true (vbb and bvg)", async () => {
    const { getRadarInstances } = await loadModule();
    // Berlin bbox: west, south, east, north
    const instances = getRadarInstances([13.2, 52.4, 13.6, 52.7]);
    const ids = instances.map((i) => i.id);
    expect(ids).toContain("vbb");
    expect(ids).toContain("bvg");
    for (const inst of instances) {
      expect(inst.hasRadar).toBe(true);
    }
  });

  it("Tokyo bbox returns empty array (no HAFAS instances cover Tokyo)", async () => {
    const { getRadarInstances } = await loadModule();
    // Tokyo bbox: west, south, east, north
    const instances = getRadarInstances([139.5, 35.5, 140.0, 35.8]);
    expect(instances).toEqual([]);
  });
});

// getStopsNearby

describe("getStopsNearby", () => {
  it("returns stop with vbb: prefix and maps suburban=true to rail mode", async () => {
    // The transport.rest /locations/nearby endpoint returns stop objects directly
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          type: "stop",
          id: "900000009102",
          name: "S+U Berlin Hauptbahnhof",
          location: { latitude: 52.525, longitude: 13.369 },
          products: { suburban: true, subway: false },
        },
      ]),
    );

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("vbb:900000009102");
    expect(stops[0].name).toBe("S+U Berlin Hauptbahnhof");
    expect(stops[0].lat).toBe(52.525);
    expect(stops[0].lng).toBe(13.369);
    expect(stops[0].modes).toContain("rail");
    expect(stops[0].provider).toBe("vbb");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops).toEqual([]);
  });

  it("calls /locations/nearby endpoint with correct params", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    await getStopsNearby(vbb, 52.525, 13.369, 500);

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/locations/nearby");
    expect(fetchUrl).toContain("latitude=52.525");
    expect(fetchUrl).toContain("longitude=13.369");
    expect(fetchUrl).toContain("distance=500");
  });
});

// getDepartures

describe("getDepartures", () => {
  it("returns Departure with correct fields and strips vbb: prefix in URL", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "trip1",
            direction: "Hamburg Hbf",
            plannedWhen: "2026-03-10T10:00:00+01:00",
            when: "2026-03-10T10:05:00+01:00",
            delay: 300,
            cancelled: false,
            line: {
              id: "re1",
              fahrtNr: "RE 1",
              name: "RE 1",
              product: "regional",
            },
            platform: "7",
            plannedPlatform: "7",
            remarks: [],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "vbb:900000009102", 30);

    expect(deps).toHaveLength(1);
    expect(deps[0].tripId).toBe("vbb:trip1");
    expect(deps[0].headsign).toBe("Hamburg Hbf");
    expect(deps[0].delaySeconds).toBe(300);
    expect(deps[0].platform).toBe("7");
    expect(deps[0].route.mode).toBe("rail");
    expect(deps[0].route.shortName).toBe("RE 1");
    expect(deps[0].canceled).toBe(false);

    // Verify prefix is stripped in URL
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/stops/900000009102/departures");
    expect(fetchUrl).not.toContain("vbb%3A");
    expect(fetchUrl).not.toContain("vbb:");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "vbb:900000009102", 30);

    expect(deps).toEqual([]);
  });

  it("computes expectedAt from scheduledAt + delay", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "t1",
            direction: "Test",
            plannedWhen: "2026-03-10T10:00:00+00:00",
            delay: 120,
            cancelled: false,
            line: { name: "S1", product: "suburban" },
            remarks: [],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps[0].delaySeconds).toBe(120);
    // expectedAt should be scheduledAt + 120 seconds
    const scheduled = new Date(deps[0].scheduledAt).getTime();
    const expected = new Date(deps[0].expectedAt as string).getTime();
    expect(expected - scheduled).toBe(120 * 1000);
  });
});

// getArrivals

describe("getArrivals", () => {
  it("calls /arrivals endpoint and returns mapped departures", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        arrivals: [
          {
            tripId: "trip-arr",
            direction: "Berlin Hbf",
            plannedWhen: "2026-03-10T11:00:00+01:00",
            delay: 0,
            cancelled: false,
            line: { id: "ic1", name: "IC 1", product: "national" },
            remarks: [],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getArrivals } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db") as HafasInstance;
    const arrivals = await getArrivals(db, "db-hafas:8000105", 60);

    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].tripId).toBe("db-hafas:trip-arr");
    expect(arrivals[0].route.mode).toBe("rail");

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/stops/8000105/arrivals");
    expect(fetchUrl).not.toContain("db-hafas%3A");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getArrivals } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db") as HafasInstance;
    const arrivals = await getArrivals(db, "db-hafas:8000105", 30);

    expect(arrivals).toEqual([]);
  });
});

// getStop

describe("getStop", () => {
  it("returns stop with prefixed id", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        type: "stop",
        id: "900000009102",
        name: "S+U Berlin Hauptbahnhof",
        location: { latitude: 52.5251, longitude: 13.3694 },
        products: { suburban: true, subway: true },
      }),
    );

    const { HAFAS_INSTANCES, getStop } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stop = await getStop(vbb, "vbb:900000009102");

    expect(stop).not.toBeNull();
    expect(stop?.id).toBe("vbb:900000009102");
    expect(stop?.name).toBe("S+U Berlin Hauptbahnhof");
    expect(stop?.lat).toBe(52.5251);
    expect(stop?.lng).toBe(13.3694);
    expect(stop?.modes).toContain("rail");
    expect(stop?.modes).toContain("subway");
  });

  it("strips vbb: prefix before API call", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(null));

    const { HAFAS_INSTANCES, getStop } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    await getStop(vbb, "vbb:900000009102");

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/stops/900000009102");
    expect(fetchUrl).not.toContain("vbb%3A");
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getStop } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stop = await getStop(vbb, "vbb:999");

    expect(stop).toBeNull();
  });
});

// searchByName

describe("searchByName", () => {
  it("returns stops with prefix applied", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          type: "stop",
          id: "900000009102",
          name: "Berlin Hauptbahnhof",
          location: { latitude: 52.525, longitude: 13.369 },
          products: { suburban: true },
        },
        {
          type: "stop",
          id: "900000100003",
          name: "Berlin Friedrichstraße",
          location: { latitude: 52.521, longitude: 13.387 },
          products: { subway: true },
        },
      ]),
    );

    const { HAFAS_INSTANCES, searchByName } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const results = await searchByName(vbb, "Berlin Hbf", 5);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("vbb:900000009102");
    expect(results[0].name).toBe("Berlin Hauptbahnhof");
    expect(results[1].id).toBe("vbb:900000100003");
  });

  it("filters out non-stop types", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          type: "stop",
          id: "s1",
          name: "Valid Stop",
          location: { latitude: 52.0, longitude: 13.0 },
          products: { bus: true },
        },
        {
          type: "location",
          id: "loc1",
          name: "Some Address",
          location: { latitude: 52.1, longitude: 13.1 },
        },
      ]),
    );

    const { HAFAS_INSTANCES, searchByName } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const results = await searchByName(vbb, "Berlin", 10);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("vbb:s1");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, searchByName } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const results = await searchByName(vbb, "test", 10);

    expect(results).toEqual([]);
  });
});

// planJourney

describe("planJourney", () => {
  it("returns null on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.6, 13.5, "2026-03-10", "10:00:00");

    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.6, 13.5, "2026-03-10", "10:00:00");

    expect(result).toBeNull();
  });

  it("returns null when journeys array is empty", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ journeys: [] }));

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.6, 13.5, "2026-03-10", "10:00:00");

    expect(result).toBeNull();
  });

  it("walking legs get mode=walking", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        journeys: [
          {
            legs: [
              {
                walking: true,
                origin: {
                  id: "origin1",
                  name: "Origin",
                  location: { latitude: 52.5, longitude: 13.4 },
                },
                destination: {
                  id: "dest1",
                  name: "Destination",
                  location: { latitude: 52.51, longitude: 13.41 },
                },
                departure: "2026-03-10T10:00:00+01:00",
                arrival: "2026-03-10T10:05:00+01:00",
                distance: 400,
              },
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    expect(result.itineraries).toHaveLength(1);
    const leg = result.itineraries[0].legs[0];
    if (!leg) throw new Error("leg was undefined");
    expect(leg.mode).toBe("walking");
    expect(leg.route).toBeUndefined();
    // walkDistance should reflect the distance field
    expect(result.itineraries[0].walkDistance).toBe(400);
  });

  it("transit legs get correct mode and route info", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        journeys: [
          {
            legs: [
              {
                walking: false,
                tripId: "trip123",
                origin: {
                  id: "origin-stop",
                  name: "Origin Stop",
                  location: { latitude: 52.5, longitude: 13.4 },
                },
                destination: {
                  id: "dest-stop",
                  name: "Dest Stop",
                  location: { latitude: 52.55, longitude: 13.45 },
                },
                departure: "2026-03-10T10:00:00+01:00",
                arrival: "2026-03-10T10:20:00+01:00",
                line: {
                  id: "s1",
                  name: "S1",
                  product: "suburban",
                },
              },
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.55, 13.45, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    if (!leg) throw new Error("leg was undefined");
    expect(leg.mode).toBe("rail");
    expect(leg.route).not.toBeUndefined();
    expect(leg.route?.shortName).toBe("S1");
    expect(leg.tripId).toBe("vbb:trip123");
    expect(leg.from.stopId).toBe("vbb:origin-stop");
    expect(leg.to.stopId).toBe("vbb:dest-stop");
  });

  it("uses arrival param when arriveBy=true", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        journeys: [
          {
            legs: [
              {
                walking: true,
                origin: { name: "A", location: { latitude: 52.5, longitude: 13.4 } },
                destination: { name: "B", location: { latitude: 52.51, longitude: 13.41 } },
                departure: "2026-03-10T09:55:00+01:00",
                arrival: "2026-03-10T10:00:00+01:00",
                distance: 100,
              },
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    await planJourney(vbb, 52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", true);

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("arrival=");
    expect(fetchUrl).not.toContain("departure=");
  });
});

// getTrip

describe("getTrip", () => {
  it("returns VehicleJourney with prefixed id and stop list", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trip: {
          id: "trip-abc",
          direction: "Spandau",
          line: { name: "S3", product: "suburban" },
          stopovers: [
            {
              stop: {
                id: "900000009102",
                name: "Berlin Hbf",
                location: { latitude: 52.525, longitude: 13.369 },
              },
              plannedArrival: null,
              plannedDeparture: "2026-03-10T10:00:00+01:00",
              departure: "2026-03-10T10:00:00+01:00",
              platform: "3",
              cancelled: false,
            },
            {
              stop: {
                id: "900000024101",
                name: "Berlin Ostbahnhof",
                location: { latitude: 52.511, longitude: 13.434 },
              },
              plannedArrival: "2026-03-10T10:05:00+01:00",
              plannedDeparture: "2026-03-10T10:06:00+01:00",
              arrival: "2026-03-10T10:05:00+01:00",
              departure: "2026-03-10T10:06:00+01:00",
              platform: "4",
              arrivalDelay: 60,
              cancelled: false,
            },
          ],
        },
      }),
    );

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const journey = await getTrip(vbb, "vbb:trip-abc");

    expect(journey).not.toBeNull();
    if (!journey) throw new Error("journey was null");
    expect(journey.id).toBe("vbb:trip-abc");
    expect(journey.name).toBe("S3");
    expect(journey.provider).toBe("vbb");
    expect(journey.stops).toHaveLength(2);

    const stop0 = journey.stops[0];
    if (!stop0) throw new Error("stop0 was undefined");
    expect(stop0.stopId).toBe("vbb:900000009102");
    expect(stop0.name).toBe("Berlin Hbf");
    expect(stop0.lat).toBe(52.525);
    expect(stop0.lng).toBe(13.369);
    expect(stop0.platform).toBe("3");

    const stop1 = journey.stops[1];
    if (!stop1) throw new Error("stop1 was undefined");
    expect(stop1.stopId).toBe("vbb:900000024101");
    expect(stop1.delaySeconds).toBe(60);
  });

  it("strips vbb: prefix before API call", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trip: {
          id: "trip-xyz",
          stopovers: [],
        },
      }),
    );

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    await getTrip(vbb, "vbb:trip-xyz");

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/trips/trip-xyz");
    expect(fetchUrl).not.toContain("vbb%3A");
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await getTrip(vbb, "vbb:nonexistent");

    expect(result).toBeNull();
  });

  it("falls back to direction as name when line is missing", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trip: {
          id: "trip-noline",
          direction: "Potsdam Hbf",
          stopovers: [],
        },
      }),
    );

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const journey = await getTrip(vbb, "vbb:trip-noline");

    expect(journey).not.toBeNull();
    expect(journey?.name).toBe("Potsdam Hbf");
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await getTrip(vbb, "vbb:trip-xyz");

    expect(result).toBeNull();
  });

  it("handles stop with departureDelay fallback", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trip: {
          id: "trip-depdelay",
          line: { name: "U7" },
          stopovers: [
            {
              stop: { id: "s1", name: "S1", location: { latitude: 0, longitude: 0 } },
              departureDelay: 30,
              cancelled: false,
            },
          ],
        },
      }),
    );

    const { HAFAS_INSTANCES, getTrip } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const journey = await getTrip(vbb, "vbb:trip-depdelay");

    expect(journey?.stops[0].delaySeconds).toBe(30);
  });
});

// getStopsNearby edge cases

describe("getStopsNearby edge cases", () => {
  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops).toEqual([]);
  });

  it("handles stop with no products (falls back to bus)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "s1",
          name: "Test",
          location: { latitude: 0, longitude: 0 },
        },
      ]),
    );

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops[0].modes).toEqual(["bus"]);
  });

  it("handles stop with all products false (falls back to bus)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "s1",
          name: "Test",
          location: { latitude: 0, longitude: 0 },
          products: { suburban: false, subway: false, bus: false },
        },
      ]),
    );

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops[0].modes).toEqual(["bus"]);
  });

  it("handles stop with missing location", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        {
          id: "s1",
          name: "Test",
          products: { bus: true },
        },
      ]),
    );

    const { HAFAS_INSTANCES, getStopsNearby } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await getStopsNearby(vbb, 52.525, 13.369, 500);

    expect(stops[0].lat).toBe(0);
    expect(stops[0].lng).toBe(0);
  });
});

// searchByName edge cases

describe("searchByName edge cases", () => {
  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, searchByName } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stops = await searchByName(vbb, "test", 10);

    expect(stops).toEqual([]);
  });
});

// getStop edge cases

describe("getStop edge cases", () => {
  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getStop } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const stop = await getStop(vbb, "vbb:test");

    expect(stop).toBeNull();
  });
});

// getDepartures edge cases

describe("getDepartures edge cases", () => {
  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps).toEqual([]);
  });

  it("handles departure with missing delay", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "t1",
            direction: "Test",
            plannedWhen: "2026-03-10T10:00:00Z",
            cancelled: false,
            line: { name: "S1" },
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps[0].delaySeconds).toBeUndefined();
    expect(deps[0].expectedAt).toBeUndefined();
  });

  it("handles departure with warning remark", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "t1",
            direction: "Test",
            plannedWhen: "2026-03-10T10:00:00Z",
            cancelled: false,
            line: { name: "S1" },
            remarks: [
              { type: "warning", summary: "Delay expected" },
              { text: "Zug fährt nicht" },
              { text: "Delay expected" }, // duplicate — should be deduplicated
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps[0].remarks).toHaveLength(2);
    expect(deps[0].remarks?.[0].type).toBe("warning");
    expect(deps[0].remarks?.[1].type).toBe("cancellation");
  });

  it("handles departure with color info", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "t1",
            direction: "Test",
            plannedWhen: "2026-03-10T10:00:00Z",
            cancelled: false,
            line: { name: "S1", color: { bg: "#FF0000" } },
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps[0].route.color).toBe("FF0000");
  });

  it("handles departure with fahrtNr fallback", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        departures: [
          {
            tripId: "t1",
            direction: "Test",
            when: "2026-03-10T10:00:00Z",
            cancelled: false,
            line: { fahrtNr: "12345" },
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getDepartures } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const deps = await getDepartures(vbb, "stop1", 30);

    expect(deps[0].route.shortName).toBe("12345");
    expect(deps[0].route.id).toContain("12345");
  });
});

// getArrivals edge cases

describe("getArrivals edge cases", () => {
  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getArrivals } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db") as HafasInstance;
    const arrivals = await getArrivals(db, "db-hafas:8000105", 30);

    expect(arrivals).toEqual([]);
  });
});

// getStopAlerts

describe("getStopAlerts", () => {
  it("always returns empty array", async () => {
    const { HAFAS_INSTANCES, getStopAlerts } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const alerts = await getStopAlerts(vbb, "vbb:stop1");

    expect(alerts).toEqual([]);
  });
});

// getRadar

describe("getRadar", () => {
  it("returns empty for instances without radar", async () => {
    const { HAFAS_INSTANCES, getRadar } = await loadModule();
    const db = HAFAS_INSTANCES.find((i) => i.id === "db") as HafasInstance;
    const vehicles = await getRadar(db, [13.2, 52.4, 13.6, 52.7]);

    expect(vehicles).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns vehicle positions for radar instances", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        movements: [
          {
            tripId: "trip1",
            location: { latitude: 52.52, longitude: 13.4 },
            bearing: 90,
            speed: 50,
            line: { id: "s1", name: "S1" },
          },
          {
            tripId: "trip2",
            location: { latitude: 52.51, longitude: 13.41 },
            line: { name: "U2" },
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, getRadar } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const vehicles = await getRadar(vbb, [13.2, 52.4, 13.6, 52.7]);

    expect(vehicles).toHaveLength(2);
    expect(vehicles[0].tripId).toBe("vbb:trip1");
    expect(vehicles[0].lat).toBe(52.52);
    expect(vehicles[0].lng).toBe(13.4);
    expect(vehicles[0].bearing).toBe(90);
    expect(vehicles[0].speed).toBe(50);
    expect(vehicles[0].label).toBe("S1");
    expect(vehicles[0].routeId).toBe("vbb:s1");
    expect(vehicles[1].tripId).toBe("vbb:trip2");
    expect(vehicles[1].bearing).toBeUndefined();
    expect(vehicles[1].speed).toBeUndefined();
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { HAFAS_INSTANCES, getRadar } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const vehicles = await getRadar(vbb, [13.2, 52.4, 13.6, 52.7]);

    expect(vehicles).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const { HAFAS_INSTANCES, getRadar } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const vehicles = await getRadar(vbb, [13.2, 52.4, 13.6, 52.7]);

    expect(vehicles).toEqual([]);
  });
});

// planJourney edge cases

describe("planJourney edge cases", () => {
  it("handles leg with polyline geometry", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        journeys: [
          {
            legs: [
              {
                walking: false,
                tripId: "trip123",
                origin: {
                  id: "origin-stop",
                  name: "Origin",
                  location: { latitude: 52.5, longitude: 13.4 },
                },
                destination: {
                  id: "dest-stop",
                  name: "Dest",
                  location: { latitude: 52.55, longitude: 13.45 },
                },
                departure: "2026-03-10T10:00:00+01:00",
                arrival: "2026-03-10T10:20:00+01:00",
                line: { id: "s1", name: "S1", product: "suburban" },
                polyline: {
                  features: [
                    {
                      geometry: {
                        type: "LineString",
                        coordinates: [
                          [13.4, 52.5],
                          [13.42, 52.52],
                          [13.45, 52.55],
                        ],
                      },
                    },
                  ],
                },
                stopovers: [{}, {}, {}, {}], // 4 stopovers = 2 intermediate
              },
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.55, 13.45, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    if (!leg) throw new Error("leg was undefined");
    // Should use the polyline geometry, not the straight line
    expect(leg.geometry.coordinates).toHaveLength(3);
    expect(leg._intermediateStopCount).toBe(2);
  });

  it("handles leg with missing origin/destination ids", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        journeys: [
          {
            legs: [
              {
                walking: false,
                tripId: "trip1",
                origin: { name: "A", location: { latitude: 52.5, longitude: 13.4 } },
                destination: { name: "B", location: { latitude: 52.55, longitude: 13.45 } },
                departure: "2026-03-10T10:00:00Z",
                arrival: "2026-03-10T10:20:00Z",
                line: {
                  id: "s1",
                  name: "S1",
                  product: "suburban",
                  productName: "S-Bahn",
                  color: { bg: "#00FF00" },
                },
              },
            ],
          },
        ],
      }),
    );

    const { HAFAS_INSTANCES, planJourney } = await loadModule();
    const vbb = HAFAS_INSTANCES.find((i) => i.id === "vbb") as HafasInstance;
    const result = await planJourney(vbb, 52.5, 13.4, 52.55, 13.45, "2026-03-10", "10:00:00");

    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    if (!leg) throw new Error("leg was undefined");
    expect(leg.from.stopId).toBeUndefined();
    expect(leg.to.stopId).toBeUndefined();
    expect(leg.route?.longName).toBe("S-Bahn");
    expect(leg.route?.color).toBe("00FF00");
  });
});
