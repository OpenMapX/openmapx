import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock transit orchestrator

const mockGetStopsInBbox = vi.fn();
const mockSearchByName = vi.fn();
const mockGetStop = vi.fn();
const mockGetDepartures = vi.fn();
const mockGetArrivals = vi.fn();
const mockGetStopAlerts = vi.fn();
const mockGetStopPlatforms = vi.fn();
const mockGetStopTimetable = vi.fn();
const mockGetRoute = vi.fn();
const mockGetRoutesInBbox = vi.fn();
const mockGetRoutesForStop = vi.fn();
const mockGetRouteStops = vi.fn();
const mockGetRouteAlerts = vi.fn();
const mockGetAlerts = vi.fn();
const mockGetVehiclePositions = vi.fn();
const mockGetVehicleRadar = vi.fn();
const mockGetVehicleJourney = vi.fn();
const mockGetFacilities = vi.fn();
const mockPlanTrip = vi.fn();
const mockGetHealthStatus = vi.fn(() => ({}));
const mockGetReachableStops = vi.fn();

vi.mock("../../services/transit/orchestrator.js", () => ({
  transitOrchestrator: {
    getStopsInBbox: mockGetStopsInBbox,
    searchByName: mockSearchByName,
    getStop: mockGetStop,
    getDepartures: mockGetDepartures,
    getArrivals: mockGetArrivals,
    getStopAlerts: mockGetStopAlerts,
    getStopPlatforms: mockGetStopPlatforms,
    getStopTimetable: mockGetStopTimetable,
    getRoute: mockGetRoute,
    getRoutesInBbox: mockGetRoutesInBbox,
    getRoutesForStop: mockGetRoutesForStop,
    getRouteStops: mockGetRouteStops,
    getRouteAlerts: mockGetRouteAlerts,
    getAlerts: mockGetAlerts,
    getVehiclePositions: mockGetVehiclePositions,
    getVehicleRadar: mockGetVehicleRadar,
    getVehicleJourney: mockGetVehicleJourney,
    getFacilities: mockGetFacilities,
    planTrip: mockPlanTrip,
    getHealthStatus: mockGetHealthStatus,
    getReachableStops: mockGetReachableStops,
  },
}));

// Mock place-transit service

const mockGetLinkedStops = vi.fn();
const mockGetMergedRoutes = vi.fn();
const mockGetMergedDepartures = vi.fn();
const mockGetMergedArrivals = vi.fn();
const mockGetMergedAlerts = vi.fn();
const mockGetMergedFacilities = vi.fn();

vi.mock("../../services/transit/place-transit.js", () => ({
  getLinkedStops: mockGetLinkedStops,
  getMergedRoutes: mockGetMergedRoutes,
  getMergedDepartures: mockGetMergedDepartures,
  getMergedArrivals: mockGetMergedArrivals,
  getMergedAlerts: mockGetMergedAlerts,
  getMergedFacilities: mockGetMergedFacilities,
}));

// Mock registry

vi.mock("../../services/transit/registry/index.js", () => ({
  registry: {
    listEntries: vi.fn(() => []),
    listProviders: vi.fn(() => []),
    findProviders: vi.fn(() => []),
    findByPrefix: vi.fn(() => null),
    initialized: true,
    entryCount: 0,
  },
}));

// Mock static-providers

vi.mock("../../services/transit/static-providers.js", () => ({
  STATIC_PROVIDER_ATTRIBUTION: {
    transitous: { label: "Transitous", url: "https://transitous.org" },
    db: { label: "Deutsche Bahn", url: "https://www.deutschebahn.com" },
  },
}));

// Mock cache utility (withCache just calls the factory fn directly)

vi.mock("../../utils/cache.js", () => ({
  hashKey: vi.fn((_prefix: string, _data: unknown) => "cache:test"),
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
}));

// Mock transit-attribution

vi.mock("../transit-attribution.js", () => ({
  getFeedProviders: vi.fn(() => ({})),
}));

// Fixtures

const MOCK_STOP = {
  id: "mo:de_berlin",
  name: "Berlin Hbf",
  lat: 52.525,
  lng: 13.369,
  modes: ["rail"],
  provider: "transitous",
};

const MOCK_DEPARTURE = {
  scheduledAt: "2026-03-10T12:00:00Z",
  expectedAt: "2026-03-10T12:02:00Z",
  delaySeconds: 120,
  platform: "5",
  headsign: "Hamburg Hbf",
  canceled: false,
  route: { id: "r:1", shortName: "ICE 1", longName: "ICE Berlin-Hamburg", mode: "rail" },
  providers: ["transitous"],
};

const MOCK_ROUTE = {
  id: "r:1",
  shortName: "ICE 1",
  longName: "ICE Berlin-Hamburg",
  mode: "rail",
  color: "#ff0000",
  operatorName: "DB Fernverkehr",
};

const MOCK_ALERT = {
  id: "alert:1",
  title: "Delay on ICE 1",
  description: "Due to construction work",
  severity: "warning",
  providers: ["transitous"],
  affectedRouteIds: [],
  affectedStopIds: [],
};

const MOCK_PLAN = {
  provider: "otp",
  itineraries: [
    {
      duration: 3600,
      startTime: "2026-03-10T12:00:00Z",
      endTime: "2026-03-10T13:00:00Z",
      legs: [],
    },
  ],
};

const MOCK_VEHICLE_JOURNEY = {
  id: "db:trip_123",
  name: "ICE 1",
  provider: "transitous",
  stops: [],
};

// Valid bbox query params

const VALID_BBOX = { sw_lat: "52.0", sw_lng: "13.0", ne_lat: "53.0", ne_lng: "14.0" };

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { transitRoute } = await import("../transit.js");
  app = Fastify({ logger: false });
  await app.register(transitRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /transit/stops", () => {
  it("returns 400 without bbox params", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/stops" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required property 'sw_lat'/i);
  });

  it("returns 400 with invalid bbox (sw_lat >= ne_lat)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops?${qs({ sw_lat: "53.0", sw_lng: "13.0", ne_lat: "52.0", ne_lng: "14.0" })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts antimeridian-crossing bbox (sw_lng > ne_lng)", async () => {
    mockGetStopsInBbox.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops?${qs({ sw_lat: "52.0", sw_lng: "170.0", ne_lat: "53.0", ne_lng: "-170.0" })}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 with valid bbox and returns stops array", async () => {
    mockGetStopsInBbox.mockResolvedValueOnce([MOCK_STOP]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops?${qs(VALID_BBOX)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("mo:de_berlin");
    expect(mockGetStopsInBbox).toHaveBeenCalledWith([13.0, 52.0, 14.0, 53.0], undefined);
  });

  it("passes modes filter when provided", async () => {
    mockGetStopsInBbox.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops?${qs({ ...VALID_BBOX, modes: "rail,bus" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetStopsInBbox).toHaveBeenCalledWith([13.0, 52.0, 14.0, 53.0], ["rail", "bus"]);
  });
});

describe("GET /transit/stops/nearby", () => {
  it("returns 400 without lat/lng", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/stops/nearby" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/lat/i);
  });

  it("returns 400 with non-numeric lat", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/nearby?${qs({ lat: "abc", lng: "13.0" })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid lat/lng", async () => {
    mockGetStopsInBbox.mockResolvedValueOnce([MOCK_STOP]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/nearby?${qs({ lat: "52.525", lng: "13.369" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    // Should call getStopsInBbox with a computed bbox
    expect(mockGetStopsInBbox).toHaveBeenCalledTimes(1);
    const [bbox] = mockGetStopsInBbox.mock.calls[0];
    // Bbox should be centered roughly around lat/lng
    expect(bbox[0]).toBeLessThan(13.369);
    expect(bbox[1]).toBeLessThan(52.525);
    expect(bbox[2]).toBeGreaterThan(13.369);
    expect(bbox[3]).toBeGreaterThan(52.525);
  });

  it("respects radius param capped at 2000m", async () => {
    mockGetStopsInBbox.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/nearby?${qs({ lat: "52.525", lng: "13.369", radius: "5000" })}`,
    });
    // Radius is capped at 2000
    const [bbox] = mockGetStopsInBbox.mock.calls[0];
    // With 2000m radius, lat delta ~= 2000/111320 ~= 0.01797
    const latDelta = 52.525 - bbox[1];
    expect(latDelta).toBeCloseTo(2000 / 111320, 3);
  });
});

describe("GET /transit/stops/search", () => {
  it("returns 400 when q param missing", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/stops/search" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required property 'q'/i);
  });

  it("returns 400 when q param is too short (< 2 chars)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/search?${qs({ q: "B" })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid query", async () => {
    mockSearchByName.mockResolvedValueOnce([MOCK_STOP]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/search?${qs({ q: "Berlin" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockSearchByName).toHaveBeenCalledWith("Berlin", 5);
  });

  it("respects limit param", async () => {
    mockSearchByName.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/search?${qs({ q: "Berlin", limit: "10" })}`,
    });
    expect(mockSearchByName).toHaveBeenCalledWith("Berlin", 10);
  });

  it("caps limit at 20", async () => {
    mockSearchByName.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/search?${qs({ q: "Berlin", limit: "100" })}`,
    });
    expect(mockSearchByName).toHaveBeenCalledWith("Berlin", 20);
  });
});

describe("GET /transit/stops/near-place", () => {
  it("returns 400 without lat/lng/name", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/stops/near-place" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/lat/i);
  });

  it("returns 400 without name", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/near-place?${qs({ lat: "52.5", lng: "13.3" })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params", async () => {
    mockGetLinkedStops.mockResolvedValueOnce([MOCK_STOP]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/near-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetLinkedStops).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", undefined);
  });

  it("passes place_id when provided", async () => {
    mockGetLinkedStops.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/near-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf", place_id: "osm:node:123" })}`,
    });
    expect(mockGetLinkedStops).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", "osm:node:123");
  });
});

describe("GET /transit/stops/:id", () => {
  it("returns 404 when not found", async () => {
    mockGetStop.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_unknown",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 200 when found (URL-encoded colon)", async () => {
    mockGetStop.mockResolvedValueOnce(MOCK_STOP);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("mo:de_berlin");
    expect(mockGetStop).toHaveBeenCalledWith("mo:de_berlin");
  });
});

describe("GET /transit/stops/:id/departures", () => {
  it("returns departures with default minutes=60", async () => {
    mockGetDepartures.mockResolvedValueOnce([MOCK_DEPARTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/departures",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetDepartures).toHaveBeenCalledWith("mo:de_berlin", 60);
  });

  it("respects custom minutes param", async () => {
    mockGetDepartures.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/mo%3Ade_berlin/departures?${qs({ minutes: "30" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetDepartures).toHaveBeenCalledWith("mo:de_berlin", 30);
  });

  it("caps minutes at 120", async () => {
    mockGetDepartures.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/mo%3Ade_berlin/departures?${qs({ minutes: "500" })}`,
    });
    expect(mockGetDepartures).toHaveBeenCalledWith("mo:de_berlin", 120);
  });
});

describe("GET /transit/stops/:id/arrivals", () => {
  it("returns arrivals with default minutes=60", async () => {
    mockGetArrivals.mockResolvedValueOnce([MOCK_DEPARTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/arrivals",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetArrivals).toHaveBeenCalledWith("mo:de_berlin", 60);
  });

  it("respects custom minutes param", async () => {
    mockGetArrivals.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/stops/mo%3Ade_berlin/arrivals?${qs({ minutes: "90" })}`,
    });
    expect(mockGetArrivals).toHaveBeenCalledWith("mo:de_berlin", 90);
  });
});

describe("GET /transit/stops/:id/platform-stops", () => {
  it("returns 200 with array of platform stops", async () => {
    const platforms = [
      { ...MOCK_STOP, id: "mo:de_berlin_p1", name: "Berlin Hbf Gl. 1" },
      { ...MOCK_STOP, id: "mo:de_berlin_p2", name: "Berlin Hbf Gl. 2" },
    ];
    mockGetStopPlatforms.mockResolvedValueOnce(platforms);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/platform-stops",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(mockGetStopPlatforms).toHaveBeenCalledWith("mo:de_berlin");
  });
});

describe("GET /transit/stops/:id/timetable", () => {
  it("returns 400 for invalid date format (not YYYY-MM-DD)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/mo%3Ade_berlin/timetable?${qs({ date: "10-03-2026" })}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/date format/i);
  });

  it("returns 200 for valid date", async () => {
    mockGetStopTimetable.mockResolvedValueOnce([MOCK_DEPARTURE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/stops/mo%3Ade_berlin/timetable?${qs({ date: "2026-03-10" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetStopTimetable).toHaveBeenCalledWith("mo:de_berlin", "2026-03-10");
  });

  it("uses current UTC date when date param is omitted", async () => {
    mockGetStopTimetable.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/timetable",
    });
    // Should be called with a valid YYYY-MM-DD string (today's UTC date)
    const [, date] = mockGetStopTimetable.mock.calls[0];
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("GET /transit/stops/:id/alerts", () => {
  it("returns 200 with alerts array", async () => {
    mockGetStopAlerts.mockResolvedValueOnce([MOCK_ALERT]);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/alerts",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].id).toBe("alert:1");
    expect(mockGetStopAlerts).toHaveBeenCalledWith("mo:de_berlin");
  });
});

describe("GET /transit/stops/:id/facilities", () => {
  it("returns 200 with facilities", async () => {
    const facilities = [{ id: "f:1", type: "elevator", status: "operational" }];
    mockGetFacilities.mockResolvedValueOnce(facilities);
    const res = await app.inject({
      method: "GET",
      url: "/transit/stops/mo%3Ade_berlin/facilities",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetFacilities).toHaveBeenCalledWith("mo:de_berlin");
  });
});

describe("GET /transit/routes", () => {
  it("returns routes for stop_id param", async () => {
    mockGetRoutesForStop.mockResolvedValueOnce([MOCK_ROUTE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/routes?${qs({ stop_id: "mo:de_berlin" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetRoutesForStop).toHaveBeenCalledWith("mo:de_berlin");
  });

  it("returns routes for valid bbox", async () => {
    mockGetRoutesInBbox.mockResolvedValueOnce([MOCK_ROUTE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/routes?${qs(VALID_BBOX)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetRoutesInBbox).toHaveBeenCalledWith([13.0, 52.0, 14.0, 53.0]);
  });

  it("returns 400 without stop_id or valid bbox", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/routes" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/stop_id|bbox/i);
  });

  it("prefers stop_id over bbox when both provided", async () => {
    mockGetRoutesForStop.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/routes?${qs({ stop_id: "mo:x", ...VALID_BBOX })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetRoutesForStop).toHaveBeenCalled();
    expect(mockGetRoutesInBbox).not.toHaveBeenCalled();
  });
});

describe("GET /transit/routes/:id", () => {
  it("returns 404 when not found", async () => {
    mockGetRoute.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: "/transit/routes/r%3Aunknown",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 200 when found", async () => {
    mockGetRoute.mockResolvedValueOnce(MOCK_ROUTE);
    const res = await app.inject({
      method: "GET",
      url: "/transit/routes/r%3A1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shortName).toBe("ICE 1");
    expect(mockGetRoute).toHaveBeenCalledWith("r:1");
  });
});

describe("GET /transit/routes/:id/stops", () => {
  it("returns 200 with route stops", async () => {
    const stops = [
      { id: "s:1", name: "Berlin Hbf", lat: 52.525, lng: 13.369, sequence: 1 },
      { id: "s:2", name: "Hamburg Hbf", lat: 53.553, lng: 10.007, sequence: 2 },
    ];
    mockGetRouteStops.mockResolvedValueOnce(stops);
    const res = await app.inject({
      method: "GET",
      url: "/transit/routes/r%3A1/stops",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(mockGetRouteStops).toHaveBeenCalledWith("r:1", undefined);
  });

  it("returns empty array when service returns empty", async () => {
    mockGetRouteStops.mockResolvedValueOnce([]);
    const res = await app.inject({ method: "GET", url: "/transit/routes/tfl%3Acentral/stops" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe("GET /transit/routes/:id/alerts", () => {
  it("returns 200 with alerts array", async () => {
    mockGetRouteAlerts.mockResolvedValueOnce([MOCK_ALERT]);
    const res = await app.inject({
      method: "GET",
      url: "/transit/routes/r%3A1/alerts",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetRouteAlerts).toHaveBeenCalledWith("r:1");
  });
});

describe("GET /transit/routes/:id/live", () => {
  it("returns 200 with { vehicles, alerts }", async () => {
    mockGetVehiclePositions.mockResolvedValueOnce([]);
    mockGetRouteAlerts.mockResolvedValueOnce([MOCK_ALERT]);
    const res = await app.inject({
      method: "GET",
      url: "/transit/routes/r%3A1/live",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("vehicles");
    expect(body).toHaveProperty("alerts");
    expect(body.alerts).toHaveLength(1);
    expect(mockGetVehiclePositions).toHaveBeenCalledWith("r:1");
    expect(mockGetRouteAlerts).toHaveBeenCalledWith("r:1");
  });
});

describe("GET /transit/alerts", () => {
  it("returns 400 without bbox", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/alerts" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required property 'sw_lat'/i);
  });

  it("returns 200 with valid bbox", async () => {
    mockGetAlerts.mockResolvedValueOnce([MOCK_ALERT]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/alerts?${qs(VALID_BBOX)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("GET /transit/vehicles", () => {
  it("returns vehicles for route_id param", async () => {
    mockGetVehiclePositions.mockResolvedValueOnce([{ id: "v:1", lat: 52.5, lng: 13.3 }]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/vehicles?${qs({ route_id: "r:1" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetVehiclePositions).toHaveBeenCalledWith("r:1");
  });

  it("returns vehicles for valid bbox (radar)", async () => {
    mockGetVehicleRadar.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/vehicles?${qs(VALID_BBOX)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetVehicleRadar).toHaveBeenCalledWith([13.0, 52.0, 14.0, 53.0]);
  });

  it("returns 400 without route_id or bbox", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/vehicles" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/route_id|bbox/i);
  });
});

describe("GET /transit/vehicles/:id", () => {
  it("returns 404 when journey not found", async () => {
    mockGetVehicleJourney.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: "/transit/vehicles/db%3Atrip_123",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 200 when found", async () => {
    mockGetVehicleJourney.mockResolvedValueOnce(MOCK_VEHICLE_JOURNEY);
    const res = await app.inject({
      method: "GET",
      url: "/transit/vehicles/db%3Atrip_123",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("db:trip_123");
    expect(mockGetVehicleJourney).toHaveBeenCalledWith("db:trip_123", undefined);
  });
});

describe("GET /transit/routes/for-place", () => {
  it("returns 400 without lat/lng/name", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/routes/for-place" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params", async () => {
    mockGetMergedRoutes.mockResolvedValueOnce([MOCK_ROUTE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/routes/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetMergedRoutes).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", undefined);
  });
});

describe("GET /transit/departures/for-place", () => {
  it("returns 400 without required params", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/departures/for-place" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params and default minutes=60", async () => {
    mockGetMergedDepartures.mockResolvedValueOnce([MOCK_DEPARTURE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/departures/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetMergedDepartures).toHaveBeenCalledWith(
      52.525,
      13.369,
      "Berlin Hbf",
      60,
      undefined,
    );
  });

  it("respects custom minutes param", async () => {
    mockGetMergedDepartures.mockResolvedValueOnce([]);
    await app.inject({
      method: "GET",
      url: `/transit/departures/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf", minutes: "30" })}`,
    });
    expect(mockGetMergedDepartures).toHaveBeenCalledWith(
      52.525,
      13.369,
      "Berlin Hbf",
      30,
      undefined,
    );
  });
});

describe("GET /transit/arrivals/for-place", () => {
  it("returns 400 without required params", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/arrivals/for-place" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params", async () => {
    mockGetMergedArrivals.mockResolvedValueOnce([MOCK_DEPARTURE]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/arrivals/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetMergedArrivals).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", 60, undefined);
  });
});

describe("GET /transit/alerts/for-place", () => {
  it("returns 400 without required params", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/alerts/for-place" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params", async () => {
    mockGetMergedAlerts.mockResolvedValueOnce([MOCK_ALERT]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/alerts/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(mockGetMergedAlerts).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", undefined);
  });
});

describe("GET /transit/facilities/for-place", () => {
  it("returns 400 without required params", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/facilities/for-place" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with valid params", async () => {
    mockGetMergedFacilities.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: "GET",
      url: `/transit/facilities/for-place?${qs({ lat: "52.525", lng: "13.369", name: "Berlin Hbf" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetMergedFacilities).toHaveBeenCalledWith(52.525, 13.369, "Berlin Hbf", undefined);
  });
});

describe("GET /transit/plan", () => {
  it("returns 400 without required coords", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/plan" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required property 'from_lat'/i);
  });

  it("returns 400 with partial coords", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/transit/plan?${qs({ from_lat: "52.5", from_lng: "13.3" })}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when planTrip returns null", async () => {
    mockPlanTrip.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/transit/plan?${qs({ from_lat: "52.5", from_lng: "13.3", to_lat: "53.5", to_lng: "10.0" })}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/unavailable/i);
  });

  it("returns 200 with valid plan", async () => {
    mockPlanTrip.mockResolvedValueOnce(MOCK_PLAN);
    const res = await app.inject({
      method: "GET",
      url: `/transit/plan?${qs({ from_lat: "52.5", from_lng: "13.3", to_lat: "53.5", to_lng: "10.0" })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().itineraries).toHaveLength(1);
    // Verify default params
    const call = mockPlanTrip.mock.calls[0][0];
    expect(call.from).toEqual({ lat: 52.5, lng: 13.3 });
    expect(call.to).toEqual({ lat: 53.5, lng: 10.0 });
    expect(call.modes).toEqual(["TRANSIT"]);
    // departureTime should be a string like "YYYY-MM-DDTHH:MM:SS"
    expect(call.departureTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("parses ISO 8601 time parameter", async () => {
    mockPlanTrip.mockResolvedValueOnce(MOCK_PLAN);
    await app.inject({
      method: "GET",
      url: `/transit/plan?${qs({ from_lat: "52.5", from_lng: "13.3", to_lat: "53.5", to_lng: "10.0", time: "2026-03-09T20:00:00Z" })}`,
    });
    const call = mockPlanTrip.mock.calls[0][0];
    expect(call.departureTime).toBe("2026-03-09T20:00:00");
  });

  it("passes custom modes param", async () => {
    mockPlanTrip.mockResolvedValueOnce(MOCK_PLAN);
    await app.inject({
      method: "GET",
      url: `/transit/plan?${qs({ from_lat: "52.5", from_lng: "13.3", to_lat: "53.5", to_lng: "10.0", modes: "BUS,RAIL" })}`,
    });
    const call = mockPlanTrip.mock.calls[0][0];
    expect(call.modes).toEqual(["BUS", "RAIL"]);
  });
});

describe("GET /transit/providers", () => {
  it("returns 200 with merged providers object", async () => {
    const res = await app.inject({ method: "GET", url: "/transit/providers" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should contain static providers
    expect(body.transitous).toEqual({ label: "Transitous", url: "https://transitous.org" });
    expect(body.db).toEqual({ label: "Deutsche Bahn", url: "https://www.deutschebahn.com" });
  });
});

describe("GET /transit/health", () => {
  it("returns 200 with health data", async () => {
    mockGetHealthStatus.mockReturnValueOnce({ transitous: { healthy: true } });
    const res = await app.inject({ method: "GET", url: "/transit/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("providers");
    expect(body.providers.transitous).toEqual({ healthy: true });
  });
});
