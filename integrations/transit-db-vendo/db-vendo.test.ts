import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks (must be at top level — hoisted by vitest)

const mockClient = {
  nearby: vi.fn(),
  stop: vi.fn(),
  departures: vi.fn(),
  arrivals: vi.fn(),
  locations: vi.fn(),
  journeys: vi.fn(),
  trip: vi.fn(),
};

vi.mock("db-vendo-client", () => ({
  createClient: vi.fn(() => mockClient),
}));

vi.mock("db-vendo-client/p/db/index.js", () => ({ profile: {} }));

// Helpers

function fptfStop(overrides: Record<string, unknown> = {}) {
  return {
    type: "stop",
    id: "8000105",
    name: "Frankfurt(Main)Hbf",
    location: { latitude: 50.107, longitude: 8.6639 },
    products: { nationalExpress: true, regional: true, suburban: false },
    ...overrides,
  };
}

// Module loader

async function loadModule() {
  return import("./provider.js");
}

// getStop

describe("getStop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TransitStop with db: prefix from raw FPTF stop", async () => {
    mockClient.stop.mockResolvedValue(fptfStop());

    const { getStop } = await loadModule();
    const result = await getStop("db:8000105");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("db:8000105");
    expect(result?.name).toBe("Frankfurt(Main)Hbf");
    expect(result?.lat).toBe(50.107);
    expect(result?.lng).toBe(8.6639);
    expect(result?.provider).toBe("db");
    expect(result?.modes).toContain("rail");
    expect(result?.codes).toEqual([{ value: "8000105", namespace: "eva" }]);
    expect(result?.codes?.map(({ value }) => value)).not.toContain("db:8000105");
  });

  it("does not expose a non-EVA source id as a public code", async () => {
    mockClient.stop.mockResolvedValue(fptfStop({ id: "not-an-eva" }));

    const { getStop } = await loadModule();
    const result = await getStop("db:not-an-eva");

    expect(result).not.toHaveProperty("codes");
  });

  it("strips db: prefix before calling client.stop", async () => {
    mockClient.stop.mockResolvedValue(fptfStop());

    const { getStop } = await loadModule();
    await getStop("db:8000105");

    expect(mockClient.stop).toHaveBeenCalledWith("8000105");
    expect(mockClient.stop).not.toHaveBeenCalledWith("db:8000105");
  });

  it("passes raw id without stripping when no prefix present", async () => {
    mockClient.stop.mockResolvedValue(fptfStop({ id: "8000105" }));

    const { getStop } = await loadModule();
    await getStop("8000105");

    expect(mockClient.stop).toHaveBeenCalledWith("8000105");
  });

  it("returns null when client throws", async () => {
    mockClient.stop.mockRejectedValue(new Error("Network failure"));

    const { getStop } = await loadModule();
    const result = await getStop("db:8000105");

    expect(result).toBeNull();
  });

  it("returns null when client returns falsy", async () => {
    mockClient.stop.mockResolvedValue(null);

    const { getStop } = await loadModule();
    const result = await getStop("db:8000105");

    expect(result).toBeNull();
  });
});

// getStopsNearby

describe("getStopsNearby", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped TransitStop array with db: prefix", async () => {
    mockClient.nearby.mockResolvedValue([
      fptfStop({ id: "8000105", products: { suburban: true } }),
      fptfStop({ id: "8000261", name: "München Hbf", products: { bus: true } }),
    ]);

    const { getStopsNearby } = await loadModule();
    const stops = await getStopsNearby(50.107, 8.6639, 500);

    expect(stops).toHaveLength(2);
    expect(stops[0].id).toBe("db:8000105");
    expect(stops[0].provider).toBe("db");
    expect(stops[1].id).toBe("db:8000261");
    expect(stops[1].name).toBe("München Hbf");
  });

  it("calls client.nearby with correct location and distance parameters", async () => {
    mockClient.nearby.mockResolvedValue([]);

    const { getStopsNearby } = await loadModule();
    await getStopsNearby(52.525, 13.369, 750);

    expect(mockClient.nearby).toHaveBeenCalledWith(
      { type: "location", latitude: 52.525, longitude: 13.369 },
      { results: 30, distance: 750 },
    );
  });

  it("returns empty array when client throws", async () => {
    mockClient.nearby.mockRejectedValue(new Error("Timeout"));

    const { getStopsNearby } = await loadModule();
    const stops = await getStopsNearby(52.525, 13.369, 500);

    expect(stops).toEqual([]);
  });

  it("maps bus product to bus mode", async () => {
    mockClient.nearby.mockResolvedValue([fptfStop({ products: { bus: true } })]);

    const { getStopsNearby } = await loadModule();
    const stops = await getStopsNearby(52.0, 13.0, 300);

    expect(stops[0].modes).toContain("bus");
  });
});

// searchByName

describe("searchByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stops and stations with db: prefix", async () => {
    mockClient.locations.mockResolvedValue([
      fptfStop({ type: "stop", id: "8000105", name: "Frankfurt Hbf" }),
      fptfStop({ type: "station", id: "8000261", name: "München Hbf" }),
    ]);

    const { searchByName } = await loadModule();
    const results = await searchByName("Frankfurt", 10);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("db:8000105");
    expect(results[1].id).toBe("db:8000261");
  });

  it("filters out non-stop types (addresses, POIs)", async () => {
    mockClient.locations.mockResolvedValue([
      fptfStop({ type: "stop", id: "8000105" }),
      {
        type: "location",
        id: "loc1",
        name: "Some Address",
        location: { latitude: 52.0, longitude: 13.0 },
      },
      { type: "poi", id: "poi1", name: "Some POI", location: { latitude: 52.1, longitude: 13.1 } },
    ]);

    const { searchByName } = await loadModule();
    const results = await searchByName("test", 10);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("db:8000105");
  });

  it("calls client.locations with correct options", async () => {
    mockClient.locations.mockResolvedValue([]);

    const { searchByName } = await loadModule();
    await searchByName("Berlin Hbf", 5);

    expect(mockClient.locations).toHaveBeenCalledWith("Berlin Hbf", {
      results: 5,
      stops: true,
      addresses: false,
      poi: false,
    });
  });

  it("returns empty array when client throws", async () => {
    mockClient.locations.mockRejectedValue(new Error("Service unavailable"));

    const { searchByName } = await loadModule();
    const results = await searchByName("test", 10);

    expect(results).toEqual([]);
  });
});

// getDepartures

describe("getDepartures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped Departure array with correct fields", async () => {
    mockClient.departures.mockResolvedValue({
      departures: [
        {
          tripId: "trip-1",
          direction: "Hamburg Hbf",
          plannedWhen: "2026-03-10T10:00:00+01:00",
          delay: 300,
          cancelled: false,
          line: {
            id: "re1",
            fahrtNr: "RE 1",
            name: "RE 1",
            productName: "Regional-Express",
            product: "regional",
          },
          platform: "7",
          plannedPlatform: "7",
          remarks: [],
        },
      ],
    });

    const { getDepartures } = await loadModule();
    const deps = await getDepartures("db:8000105", 30);

    expect(deps).toHaveLength(1);
    expect(deps[0].tripId).toBe("db:trip-1");
    expect(deps[0].headsign).toBe("Hamburg Hbf");
    expect(deps[0].delaySeconds).toBe(300);
    expect(deps[0].platform).toBe("7");
    expect(deps[0].route.mode).toBe("rail");
    expect(deps[0].route.shortName).toBe("RE 1");
    expect(deps[0].canceled).toBe(false);
  });

  it("strips db: prefix before client call", async () => {
    mockClient.departures.mockResolvedValue({ departures: [] });

    const { getDepartures } = await loadModule();
    await getDepartures("db:8000105", 30);

    const firstArg = mockClient.departures.mock.calls[0][0];
    expect(firstArg).toBe("8000105");
  });

  it("computes expectedAt from scheduledAt + delaySeconds", async () => {
    mockClient.departures.mockResolvedValue({
      departures: [
        {
          tripId: "t1",
          direction: "Test",
          plannedWhen: "2026-03-10T10:00:00+00:00",
          delay: 120,
          cancelled: false,
          line: { name: "S1", product: "suburban" },
        },
      ],
    });

    const { getDepartures } = await loadModule();
    const deps = await getDepartures("db:8000105", 30);

    expect(deps[0].delaySeconds).toBe(120);
    const scheduled = new Date(deps[0].scheduledAt).getTime();
    const expected = new Date(deps[0].expectedAt as string).getTime();
    expect(expected - scheduled).toBe(120 * 1000);
  });

  it("sets canceled=true for cancelled departures", async () => {
    mockClient.departures.mockResolvedValue({
      departures: [
        {
          tripId: "t2",
          direction: "Cancelled Train",
          plannedWhen: "2026-03-10T12:00:00+00:00",
          delay: 0,
          cancelled: true,
          line: { name: "ICE 1", product: "nationalExpress" },
        },
      ],
    });

    const { getDepartures } = await loadModule();
    const deps = await getDepartures("db:8000105", 60);

    expect(deps[0].canceled).toBe(true);
  });

  it("returns empty array when client throws", async () => {
    mockClient.departures.mockRejectedValue(new Error("API error"));

    const { getDepartures } = await loadModule();
    const deps = await getDepartures("db:8000105", 30);

    expect(deps).toEqual([]);
  });

  it("maps nationalExpress product to rail mode", async () => {
    mockClient.departures.mockResolvedValue({
      departures: [
        {
          tripId: "ice1",
          direction: "Berlin",
          plannedWhen: "2026-03-10T10:00:00+00:00",
          line: { id: "ice1", name: "ICE 1", product: "nationalExpress" },
        },
      ],
    });

    const { getDepartures } = await loadModule();
    const deps = await getDepartures("db:8000105", 30);

    expect(deps[0].route.mode).toBe("rail");
  });
});

// getArrivals

describe("getArrivals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns arrivals using data.arrivals array", async () => {
    mockClient.arrivals.mockResolvedValue({
      arrivals: [
        {
          tripId: "trip-arr",
          direction: "Berlin Hbf",
          plannedWhen: "2026-03-10T11:00:00+01:00",
          delay: 0,
          cancelled: false,
          line: { id: "ic1", name: "IC 1", product: "national" },
        },
      ],
    });

    const { getArrivals } = await loadModule();
    const arrivals = await getArrivals("db:8000105", 60);

    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].tripId).toBe("db:trip-arr");
    expect(arrivals[0].route.mode).toBe("rail");
  });

  it("strips db: prefix before client call", async () => {
    mockClient.arrivals.mockResolvedValue({ arrivals: [] });

    const { getArrivals } = await loadModule();
    await getArrivals("db:8000105", 30);

    const firstArg = mockClient.arrivals.mock.calls[0][0];
    expect(firstArg).toBe("8000105");
  });

  it("returns empty array when client throws", async () => {
    mockClient.arrivals.mockRejectedValue(new Error("timeout"));

    const { getArrivals } = await loadModule();
    const arrivals = await getArrivals("db:8000105", 30);

    expect(arrivals).toEqual([]);
  });

  it("calls client.arrivals with correct options", async () => {
    mockClient.arrivals.mockResolvedValue({ arrivals: [] });

    const { getArrivals } = await loadModule();
    await getArrivals("db:8000105", 45);

    expect(mockClient.arrivals).toHaveBeenCalledWith("8000105", {
      duration: 45,
      results: 135, // Math.min(500, Math.max(50, 45 * 3))
      remarks: true,
    });
  });
});

// getPlatformStops

describe("getPlatformStops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns child stops from station.stops with db: prefix", async () => {
    mockClient.stop.mockResolvedValue({
      id: "8000105",
      name: "Frankfurt(Main)Hbf",
      location: { latitude: 50.107, longitude: 8.6639 },
      products: { suburban: true },
      stops: [
        fptfStop({ id: "8000105-1", name: "Frankfurt Hbf Gleis 1" }),
        fptfStop({ id: "8000105-2", name: "Frankfurt Hbf Gleis 2" }),
      ],
    });

    const { getPlatformStops } = await loadModule();
    const stops = await getPlatformStops("db:8000105");

    expect(stops).toHaveLength(2);
    expect(stops[0].id).toBe("db:8000105-1");
    expect(stops[0].name).toBe("Frankfurt Hbf Gleis 1");
    expect(stops[1].id).toBe("db:8000105-2");
  });

  it("calls client.stop with subStops: true option", async () => {
    mockClient.stop.mockResolvedValue({
      id: "8000105",
      name: "Test",
      location: { latitude: 50.0, longitude: 8.0 },
      products: {},
    });

    const { getPlatformStops } = await loadModule();
    await getPlatformStops("db:8000105");

    expect(mockClient.stop).toHaveBeenCalledWith("8000105", { subStops: true });
  });

  it("strips db: prefix before client call", async () => {
    mockClient.stop.mockResolvedValue({
      id: "8000105",
      name: "Test",
      location: { latitude: 50.0, longitude: 8.0 },
      products: {},
    });

    const { getPlatformStops } = await loadModule();
    await getPlatformStops("db:8000105");

    expect(mockClient.stop.mock.calls[0][0]).toBe("8000105");
  });

  it("returns empty array when no .stops field present", async () => {
    mockClient.stop.mockResolvedValue({
      id: "8000105",
      name: "Frankfurt(Main)Hbf",
      location: { latitude: 50.107, longitude: 8.6639 },
      products: {},
      // no stops field
    });

    const { getPlatformStops } = await loadModule();
    const stops = await getPlatformStops("db:8000105");

    expect(stops).toEqual([]);
  });

  it("returns empty array when .stops is not an array", async () => {
    mockClient.stop.mockResolvedValue({
      id: "8000105",
      name: "Test",
      location: { latitude: 50.0, longitude: 8.0 },
      products: {},
      stops: null,
    });

    const { getPlatformStops } = await loadModule();
    const stops = await getPlatformStops("db:8000105");

    expect(stops).toEqual([]);
  });

  it("returns empty array when client throws", async () => {
    mockClient.stop.mockRejectedValue(new Error("Not found"));

    const { getPlatformStops } = await loadModule();
    const stops = await getPlatformStops("db:8000105");

    expect(stops).toEqual([]);
  });
});

// planJourney

describe("planJourney", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when client throws", async () => {
    mockClient.journeys.mockRejectedValue(new Error("Network error"));

    const { planJourney } = await loadModule();
    const result = await planJourney(52.5, 13.4, 52.6, 13.5, "2026-03-10", "10:00:00");

    expect(result).toBeNull();
  });

  it("returns null when journeys array is empty", async () => {
    mockClient.journeys.mockResolvedValue({ journeys: [] });

    const { planJourney } = await loadModule();
    const result = await planJourney(52.5, 13.4, 52.6, 13.5, "2026-03-10", "10:00:00");

    expect(result).toBeNull();
  });

  it("walking legs get mode=walking (critical bug fix)", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: true,
              distance: 400,
              origin: {
                name: "Origin",
                location: { latitude: 52.5, longitude: 13.4 },
              },
              destination: {
                name: "Destination",
                location: { latitude: 52.51, longitude: 13.41 },
              },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T10:05:00+01:00",
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    const result = await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    expect(leg.mode).toBe("walking");
    expect(leg.route).toBeUndefined();
    expect(result.itineraries[0].walkDistance).toBe(400);
  });

  it("transit legs get correct mode, route info, and prefixed tripId", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: false,
              tripId: "trip123",
              origin: {
                id: "8000105",
                name: "Frankfurt Hbf",
                location: { latitude: 50.107, longitude: 8.6639 },
              },
              destination: {
                id: "8000261",
                name: "München Hbf",
                location: { latitude: 48.14, longitude: 11.558 },
              },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T13:30:00+01:00",
              line: {
                id: "ice1",
                name: "ICE 1",
                productName: "Intercity-Express",
                product: "nationalExpress",
              },
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    const result = await planJourney(50.107, 8.6639, 48.14, 11.558, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const leg = result.itineraries[0].legs[0];
    expect(leg.mode).toBe("rail");
    expect(leg.route).not.toBeUndefined();
    expect(leg.route?.shortName).toBe("ICE 1");
    expect(leg.route?.longName).toBe("Intercity-Express");
    expect(leg.tripId).toBe("db:trip123");
    expect(leg.from.stopId).toBe("db:8000105");
    expect(leg.to.stopId).toBe("db:8000261");
  });

  it("maps a leg's FPTF loadFactor to occupancy", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: false,
              tripId: "trip999",
              origin: { id: "8000105", name: "A", location: { latitude: 50.1, longitude: 8.6 } },
              destination: {
                id: "8000261",
                name: "B",
                location: { latitude: 48.1, longitude: 11.5 },
              },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T13:30:00+01:00",
              line: { id: "ice1", name: "ICE 1", product: "nationalExpress" },
              loadFactor: "very-high",
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    const result = await planJourney(50.1, 8.6, 48.1, 11.5, "2026-03-10", "10:00:00");

    expect(result?.itineraries[0].legs[0].occupancy).toBe("high");
  });

  it("uses arrival param when arriveBy=true", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: true,
              distance: 100,
              origin: { name: "A", location: { latitude: 52.5, longitude: 13.4 } },
              destination: { name: "B", location: { latitude: 52.51, longitude: 13.41 } },
              departure: "2026-03-10T09:55:00+01:00",
              arrival: "2026-03-10T10:00:00+01:00",
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", true);

    const callArgs = mockClient.journeys.mock.calls[0];
    const options = callArgs[2];
    expect(options).toHaveProperty("arrival");
    expect(options).not.toHaveProperty("departure");
  });

  it("uses departure param when arriveBy=false", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: true,
              distance: 100,
              origin: { name: "A", location: { latitude: 52.5, longitude: 13.4 } },
              destination: { name: "B", location: { latitude: 52.51, longitude: 13.41 } },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T10:05:00+01:00",
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", false);

    const callArgs = mockClient.journeys.mock.calls[0];
    const options = callArgs[2];
    expect(options).toHaveProperty("departure");
    expect(options).not.toHaveProperty("arrival");
  });

  it("respects numItineraries parameter", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: true,
              distance: 100,
              origin: { name: "A", location: { latitude: 52.5, longitude: 13.4 } },
              destination: { name: "B", location: { latitude: 52.51, longitude: 13.41 } },
              departure: "2026-03-10T10:00:00+01:00",
              arrival: "2026-03-10T10:05:00+01:00",
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", false, 5);

    const callArgs = mockClient.journeys.mock.calls[0];
    const options = callArgs[2];
    expect(options.results).toBe(5);
  });

  it("forwards a mode allow-list as a db-vendo products filter", async () => {
    mockClient.journeys.mockResolvedValue({ journeys: [] });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", false, 3, {
      modes: ["REGIONAL_RAIL", "TRAM", "BUS"],
    });

    const options = mockClient.journeys.mock.calls[0][2];
    expect(options.products).toEqual({
      nationalExpress: false,
      national: false,
      regionalExpress: false,
      regional: true,
      suburban: false,
      bus: true,
      ferry: false,
      subway: false,
      tram: true,
      taxi: false,
    });
  });

  it("omits the products filter when no modes are given", async () => {
    mockClient.journeys.mockResolvedValue({ journeys: [] });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00");

    const options = mockClient.journeys.mock.calls[0][2];
    expect(options).not.toHaveProperty("products");
  });

  it("sets DB's native Deutschlandticket filter when requested", async () => {
    mockClient.journeys.mockResolvedValue({ journeys: [] });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00", false, 3, {
      deutschlandTicketOnly: true,
    });

    const options = mockClient.journeys.mock.calls[0][2];
    expect(options.deutschlandTicketConnectionsOnly).toBe(true);
  });

  it("omits the Deutschlandticket filter by default", async () => {
    mockClient.journeys.mockResolvedValue({ journeys: [] });

    const { planJourney } = await loadModule();
    await planJourney(52.5, 13.4, 52.51, 13.41, "2026-03-10", "10:00:00");

    const options = mockClient.journeys.mock.calls[0][2];
    expect(options).not.toHaveProperty("deutschlandTicketConnectionsOnly");
  });
});

describe("modesToDbProducts", () => {
  it("maps MOTIS modes to db-vendo product booleans", async () => {
    const { modesToDbProducts } = await loadModule();
    expect(modesToDbProducts(["HIGHSPEED_RAIL", "REGIONAL_RAIL", "BUS"])).toEqual({
      nationalExpress: true,
      national: false,
      regionalExpress: false,
      regional: true,
      suburban: false,
      bus: true,
      ferry: false,
      subway: false,
      tram: false,
      taxi: false,
    });
  });

  it("folds NIGHT_RAIL/COACH into the closest category and drops unmapped modes", async () => {
    const { modesToDbProducts } = await loadModule();
    const products = modesToDbProducts(["NIGHT_RAIL", "COACH", "FUNICULAR", "AERIAL_LIFT"]);
    expect(products?.national).toBe(true);
    expect(products?.bus).toBe(true);
    // FUNICULAR/AERIAL_LIFT have no DB equivalent — they add no category.
    expect(products?.tram).toBe(false);
  });

  it("returns undefined for empty input or unmappable-only modes", async () => {
    const { modesToDbProducts } = await loadModule();
    expect(modesToDbProducts(undefined)).toBeUndefined();
    expect(modesToDbProducts([])).toBeUndefined();
    expect(modesToDbProducts(["FUNICULAR", "AERIAL_LIFT"])).toBeUndefined();
  });

  it("computes duration and transfer count correctly", async () => {
    mockClient.journeys.mockResolvedValue({
      journeys: [
        {
          legs: [
            {
              walking: false,
              tripId: "t1",
              origin: { id: "s1", name: "Start", location: { latitude: 52.5, longitude: 13.4 } },
              destination: {
                id: "s2",
                name: "Mid",
                location: { latitude: 52.52, longitude: 13.42 },
              },
              departure: "2026-03-10T10:00:00+00:00",
              arrival: "2026-03-10T10:15:00+00:00",
              line: { id: "l1", name: "S1", product: "suburban" },
            },
            {
              walking: false,
              tripId: "t2",
              origin: { id: "s2", name: "Mid", location: { latitude: 52.52, longitude: 13.42 } },
              destination: {
                id: "s3",
                name: "End",
                location: { latitude: 52.55, longitude: 13.45 },
              },
              departure: "2026-03-10T10:20:00+00:00",
              arrival: "2026-03-10T10:35:00+00:00",
              line: { id: "l2", name: "U5", product: "subway" },
            },
          ],
        },
      ],
    });

    const { planJourney } = await loadModule();
    const result = await planJourney(52.5, 13.4, 52.55, 13.45, "2026-03-10", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    const itin = result.itineraries[0];
    // 2 transit legs → 1 transfer
    expect(itin.transfers).toBe(1);
    // duration = 10:35 - 10:00 = 35 minutes = 2100 seconds
    expect(itin.duration).toBe(2100);
  });
});

// getTrip

describe("getTrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns VehicleJourney with prefixed id and stop list", async () => {
    mockClient.trip.mockResolvedValue({
      trip: {
        id: "1|12345|0|80|10032026",
        direction: "Frankfurt(Main)Hbf",
        line: { name: "ICE 1", product: "nationalExpress" },
        stopovers: [
          {
            stop: {
              id: "8000261",
              name: "München Hbf",
              location: { latitude: 48.14, longitude: 11.558 },
            },
            plannedArrival: null,
            plannedDeparture: "2026-03-10T10:00:00+01:00",
            departure: "2026-03-10T10:00:00+01:00",
            platform: "12",
            cancelled: false,
          },
          {
            stop: {
              id: "8000105",
              name: "Frankfurt(Main)Hbf",
              location: { latitude: 50.107, longitude: 8.6639 },
            },
            plannedArrival: "2026-03-10T13:10:00+01:00",
            plannedDeparture: null,
            arrival: "2026-03-10T13:15:00+01:00",
            platform: "7",
            arrivalDelay: 300,
            cancelled: false,
          },
        ],
      },
    });

    const { getTrip } = await loadModule();
    const journey = await getTrip("db:1|12345|0|80|10032026");

    expect(journey).not.toBeNull();
    if (!journey) throw new Error("journey was null");
    expect(journey.id).toBe("db:1|12345|0|80|10032026");
    expect(journey.name).toBe("ICE 1");
    expect(journey.provider).toBe("db");
    expect(journey.stops).toHaveLength(2);

    const stop0 = journey.stops[0];
    if (!stop0) throw new Error("stop0 was undefined");
    expect(stop0.stopId).toBe("db:8000261");
    expect(stop0.name).toBe("München Hbf");
    expect(stop0.lat).toBe(48.14);
    expect(stop0.lng).toBe(11.558);
    expect(stop0.platform).toBe("12");

    const stop1 = journey.stops[1];
    if (!stop1) throw new Error("stop1 was undefined");
    expect(stop1.stopId).toBe("db:8000105");
    expect(stop1.delaySeconds).toBe(300);
    expect(stop1.scheduledArrival).toBe("2026-03-10T13:10:00+01:00");
    expect(stop1.expectedArrival).toBe("2026-03-10T13:15:00+01:00");
  });

  it("strips db: prefix before client call", async () => {
    mockClient.trip.mockResolvedValue({
      trip: { id: "rawTripId", stopovers: [], line: { name: "RE 1" } },
    });

    const { getTrip } = await loadModule();
    await getTrip("db:rawTripId");

    expect(mockClient.trip).toHaveBeenCalledWith("rawTripId", { stopovers: true });
  });

  it("falls back to direction as name when line is missing", async () => {
    mockClient.trip.mockResolvedValue({
      trip: {
        id: "trip-noline",
        direction: "Hamburg Hbf",
        stopovers: [],
      },
    });

    const { getTrip } = await loadModule();
    const journey = await getTrip("db:trip-noline");

    expect(journey).not.toBeNull();
    expect(journey?.name).toBe("Hamburg Hbf");
  });

  it("handles data.trip wrapper and direct format", async () => {
    // Some versions return { trip: {...} }, test the direct format too
    mockClient.trip.mockResolvedValue({
      id: "direct-trip",
      direction: "Direct Format",
      stopovers: [],
    });

    const { getTrip } = await loadModule();
    const journey = await getTrip("db:direct-trip");

    expect(journey).not.toBeNull();
    // id falls back to rawId when trip.id is not set
    expect(journey?.id).toBe("db:direct-trip");
    expect(journey?.name).toBe("Direct Format");
  });

  it("returns null when client throws", async () => {
    mockClient.trip.mockRejectedValue(new Error("Trip not found"));

    const { getTrip } = await loadModule();
    const result = await getTrip("db:invalid-trip");

    expect(result).toBeNull();
  });

  it("uses departureDelay when arrivalDelay is not set", async () => {
    mockClient.trip.mockResolvedValue({
      trip: {
        id: "t1",
        stopovers: [
          {
            stop: { id: "s1", name: "Stop", location: { latitude: 52.0, longitude: 13.0 } },
            departureDelay: 60,
            cancelled: false,
          },
        ],
      },
    });

    const { getTrip } = await loadModule();
    const journey = await getTrip("db:t1");

    expect(journey?.stops[0].delaySeconds).toBe(60);
  });
});

// getStopAlerts

describe("getStopAlerts", () => {
  it("always returns empty array (DB has no station-level alerts API)", async () => {
    const { getStopAlerts } = await loadModule();
    const alerts = await getStopAlerts("db:8000105");

    expect(alerts).toEqual([]);
  });
});
