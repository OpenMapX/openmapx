import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "../../registry/types.js";

// Mocks (must be at top level)

const mockHafasClient = {
  nearby: vi.fn(),
  locations: vi.fn(),
  stop: vi.fn(),
  departures: vi.fn(),
  arrivals: vi.fn(),
  remarks: vi.fn(),
  radar: vi.fn(),
  journeys: vi.fn(),
  trip: vi.fn(),
};

vi.mock("hafas-client", () => ({
  createClient: vi.fn(() => mockHafasClient),
}));
vi.mock("cached-hafas-client", () => ({
  createCachedHafasClient: vi.fn((client: unknown) => client),
}));
vi.mock("cached-hafas-client/stores/redis.js", () => ({
  createRedisStore: vi.fn(),
}));
vi.mock("../../../redis.js", () => ({ redis: null }));

// Test constants

const MOCK_ENTRY: RegistryEntry = {
  id: "at/oebb-hafas-mgate",
  slug: "oebb",
  prefix: "oebb:",
  name: "ÖBB",
  protocol: "hafasMgate",
  supportedLanguages: ["de"],
  options: {
    endpoint: "https://fahrplan.oebb.at/bin/mgate.exe",
    products: [
      { id: "nationalExpress", mode: "train", bitmasks: [1] },
      { id: "bus", mode: "bus", bitmasks: [64] },
    ],
  },
  coverage: { bbox: [9.5, 46.3, 17.1, 49.1], tiers: [] },
};

const FPTF_STOP = {
  type: "stop",
  id: "8100002",
  name: "Wien Hbf",
  location: { latitude: 48.185, longitude: 16.376 },
  products: { nationalExpress: true, bus: false },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// getStopsNearby

describe("getStopsNearby", () => {
  it("returns stops with oebb: prefix and provider=oebb", async () => {
    mockHafasClient.nearby.mockResolvedValue([FPTF_STOP]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stops = await hafasMgateAdapter.getStopsNearby(MOCK_ENTRY, 48.185, 16.376, 1000);

    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("oebb:8100002");
    expect(stops[0].name).toBe("Wien Hbf");
    expect(stops[0].lat).toBe(48.185);
    expect(stops[0].lng).toBe(16.376);
    expect(stops[0].modes).toContain("rail");
    expect(stops[0].provider).toBe("oebb");
  });

  it("returns empty array when nearby() throws", async () => {
    mockHafasClient.nearby.mockRejectedValue(new Error("Network error"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stops = await hafasMgateAdapter.getStopsNearby(MOCK_ENTRY, 48.185, 16.376, 1000);

    expect(stops).toEqual([]);
  });
});

// searchByName

describe("searchByName", () => {
  it("returns stops with oebb: prefix, filtering to stop/station types", async () => {
    mockHafasClient.locations.mockResolvedValue([
      FPTF_STOP,
      { type: "location", id: "addr1", name: "Some Address" },
    ]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stops = (await hafasMgateAdapter.searchByName?.(MOCK_ENTRY, "Wien", 10)) ?? [];

    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("oebb:8100002");
    expect(stops[0].name).toBe("Wien Hbf");
    expect(stops[0].provider).toBe("oebb");
  });

  it("returns empty array on error", async () => {
    mockHafasClient.locations.mockRejectedValue(new Error("fail"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stops = (await hafasMgateAdapter.searchByName?.(MOCK_ENTRY, "Wien", 10)) ?? [];

    expect(stops).toEqual([]);
  });
});

// getStopById

describe("getStopById", () => {
  it("returns stop with oebb: prefix and strips prefix before call", async () => {
    mockHafasClient.stop.mockResolvedValue(FPTF_STOP);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stop = await hafasMgateAdapter.getStopById?.(MOCK_ENTRY, "oebb:8100002");

    expect(stop).not.toBeNull();
    expect(stop?.id).toBe("oebb:8100002");
    expect(stop?.provider).toBe("oebb");

    // Verify the prefix was stripped before calling hafas-client
    expect(mockHafasClient.stop).toHaveBeenCalledWith("8100002");
  });

  it("returns null when stop() returns null", async () => {
    mockHafasClient.stop.mockResolvedValue(null);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stop = await hafasMgateAdapter.getStopById?.(MOCK_ENTRY, "oebb:unknown");

    expect(stop).toBeNull();
  });

  it("returns null on error", async () => {
    mockHafasClient.stop.mockRejectedValue(new Error("fail"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const stop = await hafasMgateAdapter.getStopById?.(MOCK_ENTRY, "oebb:999");

    expect(stop).toBeNull();
  });
});

// getDepartures

describe("getDepartures", () => {
  it("returns departures with tripId, delay, canceled, and maps remarks", async () => {
    mockHafasClient.departures.mockResolvedValue({
      departures: [
        {
          tripId: "trip-oebb-1",
          direction: "Salzburg Hbf",
          plannedWhen: "2026-03-10T10:00:00+01:00",
          delay: 120,
          cancelled: false,
          line: {
            id: "rj-101",
            name: "RJ 101",
            product: "nationalExpress",
            productName: "Railjet",
          },
          plannedPlatform: "3",
          remarks: [
            { type: "hint", summary: "Track change", text: "Details" },
            { type: "warning", summary: "Disruption", text: "Major delay" },
          ],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const deps = await hafasMgateAdapter.getDepartures(MOCK_ENTRY, "oebb:8100002", 30);

    expect(deps).toHaveLength(1);
    expect(deps[0].tripId).toBe("oebb:trip-oebb-1");
    expect(deps[0].headsign).toBe("Salzburg Hbf");
    expect(deps[0].delaySeconds).toBe(120);
    expect(deps[0].canceled).toBe(false);
    expect(deps[0].platform).toBe("3");
    expect(deps[0].route.mode).toBe("rail");
    expect(deps[0].route.shortName).toBe("RJ 101");

    // Remarks mapping: "hint" → "info", "warning" → "warning"
    expect(deps[0].remarks).toHaveLength(2);
    expect(deps[0].remarks?.[0].type).toBe("info");
    expect(deps[0].remarks?.[0].text).toContain("Track change");
    expect(deps[0].remarks?.[1].type).toBe("warning");
    expect(deps[0].remarks?.[1].text).toContain("Disruption");
  });

  it("computes expectedAt from scheduledAt + delay", async () => {
    mockHafasClient.departures.mockResolvedValue([
      {
        tripId: "t1",
        direction: "Test",
        plannedWhen: "2026-03-10T10:00:00+00:00",
        delay: 300,
        cancelled: false,
        line: { name: "S1", product: "nationalExpress" },
      },
    ]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const deps = await hafasMgateAdapter.getDepartures(MOCK_ENTRY, "oebb:8100002", 30);

    expect(deps).toHaveLength(1);
    expect(deps[0].delaySeconds).toBe(300);
    const scheduled = new Date(deps[0].scheduledAt).getTime();
    const expected = new Date(deps[0].expectedAt as string).getTime();
    expect(expected - scheduled).toBe(300 * 1000);
  });

  it("strips prefix before calling hafas-client", async () => {
    mockHafasClient.departures.mockResolvedValue([]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    await hafasMgateAdapter.getDepartures(MOCK_ENTRY, "oebb:8100002", 30);

    expect(mockHafasClient.departures).toHaveBeenCalledWith("8100002", expect.any(Object));
  });

  it("returns empty array on error", async () => {
    mockHafasClient.departures.mockRejectedValue(new Error("fail"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const deps = await hafasMgateAdapter.getDepartures(MOCK_ENTRY, "oebb:8100002", 30);

    expect(deps).toEqual([]);
  });
});

// getArrivals

describe("getArrivals", () => {
  it("returns arrivals with correct fields", async () => {
    mockHafasClient.arrivals.mockResolvedValue({
      arrivals: [
        {
          tripId: "trip-arr-1",
          direction: "Wien Hbf",
          plannedWhen: "2026-03-10T11:00:00+01:00",
          delay: 60,
          cancelled: true,
          line: { id: "ic-42", name: "IC 42", product: "nationalExpress" },
          remarks: [],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const arrivals = await hafasMgateAdapter.getArrivals(MOCK_ENTRY, "oebb:8100002", 60);

    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].tripId).toBe("oebb:trip-arr-1");
    expect(arrivals[0].route.mode).toBe("rail");
    expect(arrivals[0].canceled).toBe(true);
    expect(arrivals[0].delaySeconds).toBe(60);
  });

  it("strips prefix before calling hafas-client", async () => {
    mockHafasClient.arrivals.mockResolvedValue([]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    await hafasMgateAdapter.getArrivals(MOCK_ENTRY, "oebb:8100002", 30);

    expect(mockHafasClient.arrivals).toHaveBeenCalledWith("8100002", expect.any(Object));
  });

  it("returns empty array on error", async () => {
    mockHafasClient.arrivals.mockRejectedValue(new Error("fail"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const arrivals = await hafasMgateAdapter.getArrivals(MOCK_ENTRY, "oebb:8100002", 30);

    expect(arrivals).toEqual([]);
  });
});

// getAlerts

describe("getAlerts", () => {
  it("returns ServiceAlerts from remarks with severity=warning", async () => {
    mockHafasClient.remarks.mockResolvedValue({
      remarks: [
        {
          type: "warning",
          id: "w1",
          summary: "Disruption",
          text: "Delays on Railjet services",
          affectedLines: [{ id: "rj-101" }],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const alerts = (await hafasMgateAdapter.getAlerts?.(MOCK_ENTRY, {})) ?? [];

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("w1");
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toBe("Disruption");
    expect(alerts[0].description).toBe("Delays on Railjet services");
    expect(alerts[0].providers).toContain("oebb");
    expect(alerts[0].affectedRouteIds).toContain("oebb:rj-101");
  });

  it("filters out non-warning remarks", async () => {
    mockHafasClient.remarks.mockResolvedValue({
      remarks: [
        { type: "hint", id: "h1", summary: "Hint text", text: "Detail" },
        { type: "warning", id: "w2", summary: "Warning text", text: "Detail2" },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const alerts = (await hafasMgateAdapter.getAlerts?.(MOCK_ENTRY, {})) ?? [];

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("w2");
  });

  it("returns empty array when remarks() throws (graceful degradation)", async () => {
    mockHafasClient.remarks.mockRejectedValue(new Error("Not supported"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const alerts = (await hafasMgateAdapter.getAlerts?.(MOCK_ENTRY, {})) ?? [];

    expect(alerts).toEqual([]);
  });

  it("maps priority < 50 to severity=severe", async () => {
    mockHafasClient.remarks.mockResolvedValue([
      {
        type: "warning",
        id: "w-critical",
        summary: "Critical disruption",
        text: "Full line closure",
        priority: 10,
        affectedLines: [],
      },
    ]);

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const alerts = (await hafasMgateAdapter.getAlerts?.(MOCK_ENTRY, {})) ?? [];

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("severe");
  });
});

// getVehicleRadar

describe("getVehicleRadar", () => {
  it("returns VehiclePositions with correct lat/lng and provider=oebb", async () => {
    mockHafasClient.radar.mockResolvedValue({
      movements: [
        {
          tripId: "t1",
          line: { id: "u1-line", name: "U1", product: "subway" },
          location: { latitude: 48.2, longitude: 16.38 },
          nextStopovers: [{ stop: { id: "s1" } }],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const vehicles =
      (await hafasMgateAdapter.getVehicleRadar?.(MOCK_ENTRY, [16.2, 48.1, 16.5, 48.3])) ?? [];

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].id).toBe("oebb:t1");
    expect(vehicles[0].provider).toBe("oebb");
    expect(vehicles[0].tripId).toBe("oebb:t1");
    expect(vehicles[0].lat).toBe(48.2);
    expect(vehicles[0].lng).toBe(16.38);
    expect(vehicles[0].label).toBe("U1");
    expect(vehicles[0].currentStopId).toBe("oebb:s1");
    expect(vehicles[0].routeId).toBe("oebb:u1-line");
  });

  it("returns empty array when radar() throws (graceful degradation)", async () => {
    mockHafasClient.radar.mockRejectedValue(new Error("Radar not supported"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const vehicles =
      (await hafasMgateAdapter.getVehicleRadar?.(MOCK_ENTRY, [16.2, 48.1, 16.5, 48.3])) ?? [];

    expect(vehicles).toEqual([]);
  });

  it("filters out movements without location coordinates", async () => {
    mockHafasClient.radar.mockResolvedValue({
      movements: [
        {
          tripId: "t-no-loc",
          line: { name: "X1" },
          location: { latitude: null, longitude: null },
        },
        {
          tripId: "t-valid",
          line: { name: "U2" },
          location: { latitude: 48.21, longitude: 16.39 },
          nextStopovers: [],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const vehicles =
      (await hafasMgateAdapter.getVehicleRadar?.(MOCK_ENTRY, [16.2, 48.1, 16.5, 48.3])) ?? [];

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].id).toBe("oebb:t-valid");
  });
});

// planJourney

describe("planJourney", () => {
  it("returns null when no journeys are returned", async () => {
    mockHafasClient.journeys.mockResolvedValue({ journeys: [] });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const result = await hafasMgateAdapter.planJourney(
      MOCK_ENTRY,
      48.2,
      16.37,
      47.81,
      13.04,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).toBeNull();
  });

  it("walking legs get mode=walking and no route", async () => {
    mockHafasClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: true,
              origin: {
                name: "Start",
                location: { latitude: 48.2, longitude: 16.37 },
              },
              destination: {
                name: "End",
                location: { latitude: 48.201, longitude: 16.371 },
              },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T10:05:00+01:00",
            },
          ],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const result = await hafasMgateAdapter.planJourney(
      MOCK_ENTRY,
      48.2,
      16.37,
      48.201,
      16.371,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    expect(result.itineraries).toHaveLength(1);
    const leg = result.itineraries[0].legs[0];
    expect(leg.mode).toBe("walking");
    expect(leg.route).toBeUndefined();
  });

  it("transit legs get correct mode, route, and prefixed tripId", async () => {
    mockHafasClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: false,
              tripId: "trip-rj-123",
              origin: {
                id: "8100002",
                name: "Wien Hbf",
                location: { latitude: 48.185, longitude: 16.376 },
              },
              destination: {
                id: "8100008",
                name: "Salzburg Hbf",
                location: { latitude: 47.813, longitude: 13.046 },
              },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T12:30:00+01:00",
              line: {
                id: "rj-101",
                name: "RJ 101",
                product: "nationalExpress",
                productName: "Railjet",
              },
              stopovers: [
                { stop: { id: "8100002" } },
                { stop: { id: "8100100" } },
                { stop: { id: "8100008" } },
              ],
            },
          ],
        },
      ],
    });

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const result = await hafasMgateAdapter.planJourney(
      MOCK_ENTRY,
      48.185,
      16.376,
      47.813,
      13.046,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    expect(leg.mode).toBe("rail");
    expect(leg.route).toBeDefined();
    expect(leg.route?.shortName).toBe("RJ 101");
    expect(leg.tripId).toBe("oebb:trip-rj-123");
    expect(leg.from.stopId).toBe("oebb:8100002");
    expect(leg.to.stopId).toBe("oebb:8100008");
    // 3 stopovers minus 2 (origin+destination) = 1 intermediate
    expect(leg._intermediateStopCount).toBe(1);
  });

  it("returns null on error", async () => {
    mockHafasClient.journeys.mockRejectedValue(new Error("Network error"));

    const { hafasMgateAdapter } = await import("../hafas-mgate.js");
    const result = await hafasMgateAdapter.planJourney(
      MOCK_ENTRY,
      48.2,
      16.37,
      47.81,
      13.04,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).toBeNull();
  });
});
