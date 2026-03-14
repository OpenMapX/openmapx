import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "../../registry/types.js";

// Mocks

vi.mock("../../../../utils/otp.js", () => ({
  otpMode: (mode: string | undefined): string => {
    if (!mode) return "bus";
    const map: Record<string, string> = {
      BUS: "bus",
      RAIL: "rail",
      SUBWAY: "subway",
      TRAM: "tram",
      FERRY: "ferry",
      GONDOLA: "gondola",
      FUNICULAR: "funicular",
      CABLE_CAR: "cable_car",
      MONORAIL: "monorail",
      WALK: "walking",
    };
    return map[mode.toUpperCase()] ?? "bus";
  },
}));

vi.mock("../../../../utils/polyline.js", () => ({
  decodePolyline: (_encoded: string): [number, number][] => {
    // Return a simple two-point line for testing
    return [
      [10.75, 59.91],
      [10.76, 59.92],
    ];
  },
}));

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockGraphQL(data: unknown) {
  return { ok: true, json: async () => ({ data }) } as Response;
}

// Test constants

const MOCK_ENTRY: RegistryEntry = {
  id: "no/entur-otp-graphql",
  slug: "entur",
  prefix: "entur:",
  name: "Entur Norway",
  protocol: "otpGraphQl",
  supportedLanguages: ["no"],
  options: {
    endpoint: "https://api.entur.io/journey-planner/v2/graphql",
    apiKey: "test-key",
  },
  coverage: { bbox: [4.0, 57.0, 32.0, 71.5], tiers: [] },
};

// getStopsNearby

describe("getStopsNearby", () => {
  it("returns stops with entur: prefix and correct modes", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        nearest: {
          edges: [
            {
              node: {
                place: {
                  gtfsId: "ENT:Stop:1",
                  name: "Oslo S",
                  lat: 59.91,
                  lon: 10.75,
                  vehicleMode: "RAIL",
                  parentStation: null,
                  platformCode: null,
                },
                distance: 50,
              },
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stops = await otpGraphQlAdapter.getStopsNearby(MOCK_ENTRY, 59.91, 10.75, 1000);

    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("entur:ENT:Stop:1");
    expect(stops[0].name).toBe("Oslo S");
    expect(stops[0].lat).toBe(59.91);
    expect(stops[0].lng).toBe(10.75);
    expect(stops[0].modes).toContain("rail");
    expect(stops[0].provider).toBe("entur");
  });

  it("sends ET-Client-Name header", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ nearest: { edges: [] } }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    await otpGraphQlAdapter.getStopsNearby(MOCK_ENTRY, 59.91, 10.75, 1000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0];
    const requestInit = fetchCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["ET-Client-Name"]).toBe("OpenMapX");
  });

  it("sends Authorization header when apiKey is set", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ nearest: { edges: [] } }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    await otpGraphQlAdapter.getStopsNearby(MOCK_ENTRY, 59.91, 10.75, 1000);

    const fetchCall = mockFetch.mock.calls[0];
    const requestInit = fetchCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("returns empty array when nearest is null", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ nearest: null }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stops = await otpGraphQlAdapter.getStopsNearby(MOCK_ENTRY, 59.91, 10.75, 1000);

    expect(stops).toEqual([]);
  });
});

// searchByName

describe("searchByName", () => {
  it("returns stops with entur: prefix", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stops: [
          {
            gtfsId: "ENT:Stop:1",
            name: "Oslo S",
            lat: 59.91,
            lon: 10.75,
            vehicleMode: "RAIL",
            parentStation: null,
            platformCode: null,
          },
        ],
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stops = (await otpGraphQlAdapter.searchByName?.(MOCK_ENTRY, "Oslo", 10)) ?? [];

    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("entur:ENT:Stop:1");
    expect(stops[0].name).toBe("Oslo S");
    expect(stops[0].provider).toBe("entur");
  });

  it("returns empty array on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stops = (await otpGraphQlAdapter.searchByName?.(MOCK_ENTRY, "Oslo", 10)) ?? [];

    expect(stops).toEqual([]);
  });
});

// getStopById

describe("getStopById", () => {
  it("returns stop and strips entur: prefix before sending", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          gtfsId: "ENT:Stop:1",
          name: "Oslo S",
          lat: 59.91,
          lon: 10.75,
          vehicleMode: "RAIL",
          parentStation: null,
          platformCode: null,
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stop = await otpGraphQlAdapter.getStopById?.(MOCK_ENTRY, "entur:ENT:Stop:1");

    expect(stop).not.toBeNull();
    expect(stop?.id).toBe("entur:ENT:Stop:1");
    expect(stop?.provider).toBe("entur");

    // Verify prefix was stripped in the GraphQL variables
    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.variables.id).toBe("ENT:Stop:1");
  });

  it("returns null when stop is not found", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ stop: null }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const stop = await otpGraphQlAdapter.getStopById?.(MOCK_ENTRY, "entur:ENT:Stop:unknown");

    expect(stop).toBeNull();
  });
});

// getDepartures

describe("getDepartures", () => {
  it("maps canceled via realtimeState=CANCELED", async () => {
    // serviceDay is Unix timestamp for midnight: 2026-03-10T00:00:00Z = 1773014400
    const serviceDay = 1773014400;

    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          stoptimesWithoutPatterns: [
            {
              scheduledDeparture: 36000, // 10:00:00 (seconds from midnight)
              realtimeDeparture: 36120,
              scheduledArrival: 35940,
              realtimeArrival: 36060,
              realtime: true,
              realtimeState: "CANCELED",
              departureDelay: 120,
              arrivalDelay: 120,
              serviceDay,
              headsign: "Bergen",
              trip: {
                gtfsId: "ENT:Trip:1001",
                route: {
                  gtfsId: "ENT:Route:R1",
                  shortName: "R10",
                  longName: "Oslo-Bergen",
                  mode: "RAIL",
                  color: "FF0000",
                },
              },
            },
            {
              scheduledDeparture: 37800, // 10:30:00
              realtimeDeparture: 37800,
              scheduledArrival: 37740,
              realtimeArrival: 37740,
              realtime: false,
              realtimeState: "SCHEDULED",
              departureDelay: 0,
              arrivalDelay: 0,
              serviceDay,
              headsign: "Trondheim",
              trip: {
                gtfsId: "ENT:Trip:1002",
                route: {
                  gtfsId: "ENT:Route:R2",
                  shortName: "R20",
                  longName: "Oslo-Trondheim",
                  mode: "RAIL",
                  color: null,
                },
              },
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const deps = await otpGraphQlAdapter.getDepartures(MOCK_ENTRY, "entur:ENT:Stop:1", 60);

    expect(deps).toHaveLength(2);

    // First departure: CANCELED with delay
    expect(deps[0].canceled).toBe(true);
    expect(deps[0].delaySeconds).toBe(120);
    expect(deps[0].tripId).toBe("entur:ENT:Trip:1001");
    expect(deps[0].route.id).toBe("entur:ENT:Route:R1");
    expect(deps[0].route.shortName).toBe("R10");
    expect(deps[0].route.mode).toBe("rail");
    expect(deps[0].headsign).toBe("Bergen");

    // scheduledAt should be serviceDay + scheduledDeparture
    const expectedScheduledAt = new Date((serviceDay + 36000) * 1000).toISOString();
    expect(deps[0].scheduledAt).toBe(expectedScheduledAt);

    // expectedAt should be serviceDay + realtimeDeparture (realtime=true)
    const expectedExpectedAt = new Date((serviceDay + 36120) * 1000).toISOString();
    expect(deps[0].expectedAt).toBe(expectedExpectedAt);

    // Second departure: SCHEDULED, no realtime
    expect(deps[1].canceled).toBe(false);
    expect(deps[1].delaySeconds).toBeUndefined();
    expect(deps[1].expectedAt).toBeUndefined();
  });

  it("strips entur: prefix from stopId before GraphQL query", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ stop: { stoptimesWithoutPatterns: [] } }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    await otpGraphQlAdapter.getDepartures(MOCK_ENTRY, "entur:ENT:Stop:1", 30);

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.variables.id).toBe("ENT:Stop:1");
  });

  it("returns empty array on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fail"));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const deps = await otpGraphQlAdapter.getDepartures(MOCK_ENTRY, "entur:ENT:Stop:1", 30);

    expect(deps).toEqual([]);
  });
});

// getArrivals

describe("getArrivals", () => {
  it("uses arrival seconds instead of departure seconds", async () => {
    const serviceDay = 1773014400;

    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          stoptimesWithoutPatterns: [
            {
              scheduledDeparture: 36000,
              realtimeDeparture: 36120,
              scheduledArrival: 35940, // 09:59:00
              realtimeArrival: 36060, // 10:01:00
              realtime: true,
              realtimeState: "SCHEDULED",
              departureDelay: 120,
              arrivalDelay: 120,
              serviceDay,
              headsign: "Oslo S",
              trip: {
                gtfsId: "ENT:Trip:2001",
                route: {
                  gtfsId: "ENT:Route:R3",
                  shortName: "R30",
                  longName: "Bergen-Oslo",
                  mode: "RAIL",
                  color: null,
                },
              },
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const arrivals = await otpGraphQlAdapter.getArrivals(MOCK_ENTRY, "entur:ENT:Stop:1", 60);

    expect(arrivals).toHaveLength(1);

    // scheduledAt should use scheduledArrival (35940), not scheduledDeparture
    const expectedScheduledAt = new Date((serviceDay + 35940) * 1000).toISOString();
    expect(arrivals[0].scheduledAt).toBe(expectedScheduledAt);

    // expectedAt should use realtimeArrival (36060), not realtimeDeparture
    const expectedExpectedAt = new Date((serviceDay + 36060) * 1000).toISOString();
    expect(arrivals[0].expectedAt).toBe(expectedExpectedAt);

    // delaySeconds should use arrivalDelay, not departureDelay
    expect(arrivals[0].delaySeconds).toBe(120);
  });
});

// getAlerts

describe("getAlerts", () => {
  it("returns alerts from stop with correct severity mapping", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          alerts: [
            {
              id: "a1",
              alertSeverityLevel: "SEVERE",
              alertEffect: "NO_SERVICE",
              alertHeaderText: "Closed",
              alertDescriptionText: "Maintenance",
              effectiveStartDate: 1741600800,
              effectiveEndDate: 1741644000,
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const alerts =
      (await otpGraphQlAdapter.getAlerts?.(MOCK_ENTRY, {
        stopId: "entur:ENT:Stop:1",
      })) ?? [];

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("a1");
    expect(alerts[0].severity).toBe("severe");
    expect(alerts[0].effect).toBe("no-service");
    expect(alerts[0].title).toBe("Closed");
    expect(alerts[0].description).toBe("Maintenance");
    expect(alerts[0].providers).toContain("entur");

    // activePeriods: Unix timestamp → ISO string
    expect(alerts[0].activePeriods).toHaveLength(1);
    expect(alerts[0].activePeriods[0].start).toBe(new Date(1741600800 * 1000).toISOString());
    expect(alerts[0].activePeriods[0].end).toBe(new Date(1741644000 * 1000).toISOString());
  });

  it("maps WARNING severity correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          alerts: [
            {
              id: "a2",
              alertSeverityLevel: "WARNING",
              alertEffect: "REDUCED_SERVICE",
              alertHeaderText: "Delays",
              alertDescriptionText: "Minor delays expected",
              effectiveStartDate: null,
              effectiveEndDate: null,
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const alerts =
      (await otpGraphQlAdapter.getAlerts?.(MOCK_ENTRY, {
        stopId: "entur:ENT:Stop:1",
      })) ?? [];

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].activePeriods).toEqual([]);
  });

  it("maps INFO severity correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        stop: {
          alerts: [
            {
              id: "a3",
              alertSeverityLevel: "INFO",
              alertHeaderText: "Info notice",
              alertDescriptionText: "Details",
              effectiveStartDate: null,
              effectiveEndDate: null,
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const alerts =
      (await otpGraphQlAdapter.getAlerts?.(MOCK_ENTRY, {
        stopId: "entur:ENT:Stop:1",
      })) ?? [];

    expect(alerts[0].severity).toBe("info");
  });

  it("strips prefix from stopId before query", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ stop: { alerts: [] } }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    await otpGraphQlAdapter.getAlerts?.(MOCK_ENTRY, { stopId: "entur:ENT:Stop:1" });

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.variables.id).toBe("ENT:Stop:1");
  });

  it("returns empty array on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fail"));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const alerts =
      (await otpGraphQlAdapter.getAlerts?.(MOCK_ENTRY, {
        stopId: "entur:ENT:Stop:1",
      })) ?? [];

    expect(alerts).toEqual([]);
  });
});

// planJourney

describe("planJourney", () => {
  it("returns null when GraphQL data is null", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: null }) } as Response);

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const result = await otpGraphQlAdapter.planJourney(
      MOCK_ENTRY,
      59.91,
      10.75,
      60.39,
      5.32,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).toBeNull();
  });

  it("returns null when itineraries are empty", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphQL({ plan: { itineraries: [] } }));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const result = await otpGraphQlAdapter.planJourney(
      MOCK_ENTRY,
      59.91,
      10.75,
      60.39,
      5.32,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).toBeNull();
  });

  it("returns TripPlan with correct structure on success", async () => {
    const startTimeMs = new Date("2026-03-10T10:00:00Z").getTime();
    const endTimeMs = new Date("2026-03-10T10:10:00Z").getTime();
    const transitStartMs = new Date("2026-03-10T10:12:00Z").getTime();
    const transitEndMs = new Date("2026-03-10T11:30:00Z").getTime();

    mockFetch.mockResolvedValueOnce(
      mockGraphQL({
        plan: {
          from: { name: "Start", lat: 59.91, lon: 10.75 },
          to: { name: "End", lat: 60.39, lon: 5.32 },
          itineraries: [
            {
              duration: 5400,
              startTime: startTimeMs,
              endTime: transitEndMs,
              walkDistance: 350,
              legs: [
                {
                  mode: "WALK",
                  transitLeg: false,
                  startTime: startTimeMs,
                  endTime: endTimeMs,
                  distance: 350,
                  from: { name: "Origin", lat: 59.91, lon: 10.75, stop: null },
                  to: { name: "Oslo S", lat: 59.911, lon: 10.753, stop: { gtfsId: "ENT:Stop:1" } },
                  route: null,
                  trip: null,
                  legGeometry: null,
                  intermediateStops: [],
                },
                {
                  mode: "RAIL",
                  transitLeg: true,
                  startTime: transitStartMs,
                  endTime: transitEndMs,
                  distance: 450000,
                  from: {
                    name: "Oslo S",
                    lat: 59.911,
                    lon: 10.753,
                    stop: { gtfsId: "ENT:Stop:1" },
                  },
                  to: { name: "Bergen", lat: 60.39, lon: 5.32, stop: { gtfsId: "ENT:Stop:2" } },
                  route: { shortName: "R10", longName: "Oslo-Bergen", color: "#FF0000" },
                  trip: { gtfsId: "ENT:Trip:5001" },
                  legGeometry: { points: "encodedPolyline" },
                  intermediateStops: [{ gtfsId: "ENT:Stop:3" }, { gtfsId: "ENT:Stop:4" }],
                },
              ],
            },
          ],
        },
      }),
    );

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const result = await otpGraphQlAdapter.planJourney(
      MOCK_ENTRY,
      59.91,
      10.75,
      60.39,
      5.32,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");
    expect(result.from.name).toBe("Start");
    expect(result.to.name).toBe("End");
    expect(result.itineraries).toHaveLength(1);

    const itinerary = result.itineraries[0];
    expect(itinerary.duration).toBe(5400);
    expect(itinerary.walkDistance).toBe(350);
    expect(itinerary.transfers).toBe(0); // 1 transit leg - 1 = 0

    // Walking leg
    const walkLeg = itinerary.legs[0];
    expect(walkLeg.mode).toBe("walking");
    expect(walkLeg.route).toBeUndefined();

    // Transit leg
    const transitLeg = itinerary.legs[1];
    expect(transitLeg.mode).toBe("rail");
    expect(transitLeg.route).toBeDefined();
    expect(transitLeg.route?.shortName).toBe("R10");
    expect(transitLeg.tripId).toBe("entur:ENT:Trip:5001");
    expect(transitLeg.from.stopId).toBe("entur:ENT:Stop:1");
    expect(transitLeg.to.stopId).toBe("entur:ENT:Stop:2");
    expect(transitLeg._intermediateStopCount).toBe(2);
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const { otpGraphQlAdapter } = await import("../otp-graphql.js");
    const result = await otpGraphQlAdapter.planJourney(
      MOCK_ENTRY,
      59.91,
      10.75,
      60.39,
      5.32,
      "2026-03-10",
      "10:00:00",
    );

    expect(result).toBeNull();
  });
});
