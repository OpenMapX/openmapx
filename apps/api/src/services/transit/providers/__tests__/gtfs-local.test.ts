import type {
  GtfsDepartureRow,
  GtfsDeps,
  GtfsStopRow,
} from "@integrations/transit-gtfs-local/gtfs-local";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedFeed } from "../../../gtfs/types.js";

// Mock dependencies injected via setDeps()

const mockGetStopsInBbox = vi.fn();
const mockGetStopById = vi.fn();
const mockSearchStopsByName = vi.fn();
const mockGetDepartures = vi.fn();
const mockGetArrivals = vi.fn();
const mockGetDeparturesByDate = vi.fn();
const mockGetChildStops = vi.fn();

const routeTypeToMode = (n: number) => {
  const map: Record<number, string> = {
    0: "tram",
    1: "subway",
    2: "rail",
    3: "bus",
    4: "ferry",
    5: "cable_car",
    6: "gondola",
    7: "funicular",
    11: "bus",
    12: "monorail",
  };
  return map[n] ?? "bus";
};

const mockGtfsManager = {
  initialized: true,
  getActiveFeedsForBbox: vi.fn(),
  getFeeds: vi.fn(),
  getSchemaForStopId: vi.fn(),
  getOriginalStopId: vi.fn(),
  getSlugFromStopId: vi.fn(),
};

const mockDeps: GtfsDeps = {
  manager: mockGtfsManager as unknown as GtfsDeps["manager"],
  queries: {
    getStopsInBbox: mockGetStopsInBbox,
    getStopById: mockGetStopById,
    searchStopsByName: mockSearchStopsByName,
    getDepartures: mockGetDepartures,
    getArrivals: mockGetArrivals,
    getDeparturesByDate: mockGetDeparturesByDate,
    getChildStops: mockGetChildStops,
    routeTypeToMode,
  } as unknown as GtfsDeps["queries"],
};

// Helpers

function makeFeed(slug: string, schemaName: string): ImportedFeed {
  return {
    slug,
    name: `Feed ${slug}`,
    url: `https://example.com/${slug}.zip`,
    originUrl: null,
    source: "transitous",
    countryCode: "de",
    schemaName,
    status: "active",
    bbox: [6.0, 47.0, 15.0, 55.0],
    feedHash: "abc123",
    importedAt: "2026-01-01T00:00:00Z",
    lastCheckedAt: "2026-01-01T00:00:00Z",
    errorMessage: null,
    stopCount: 100,
    routeCount: 20,
    tripCount: 500,
    serviceEndDate: null,
    currentStage: null,
  };
}

function makeStopRow(overrides: Partial<GtfsStopRow> = {}): GtfsStopRow {
  return {
    stop_id: "1234",
    stop_name: "Test Stop",
    stop_lat: 51.5,
    stop_lon: 7.2,
    location_type: 0,
    parent_station: null,
    platform_code: null,
    route_types: [3], // bus
    ...overrides,
  };
}

function makeDepartureRow(overrides: Partial<GtfsDepartureRow> = {}): GtfsDepartureRow {
  return {
    trip_id: "trip_abc",
    route_id: "route_01",
    route_short_name: "RE 1",
    route_long_name: "Regional Express 1",
    route_type: 2, // rail
    route_color: "#FF0000",
    trip_headsign: "Dortmund Hbf",
    t_departure: "2026-03-10T10:30:00Z",
    stop_sequence: 1,
    ...overrides,
  };
}

// Load module and inject deps

async function loadModule() {
  const mod = await import("@integrations/transit-gtfs-local/gtfs-local");
  mod.setDeps(mockDeps);
  return mod;
}

// Tests

describe("gtfs-local provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGtfsManager.initialized = true;
  });

  // isGtfsLocalId

  describe("isGtfsLocalId", () => {
    it("returns true for g- prefixed IDs", async () => {
      const { isGtfsLocalId } = await loadModule();
      expect(isGtfsLocalId("g-de-nrw:1234")).toBe(true);
    });

    it("returns true for any g- prefixed ID", async () => {
      const { isGtfsLocalId } = await loadModule();
      expect(isGtfsLocalId("g-us-mbta:abc")).toBe(true);
      expect(isGtfsLocalId("g-ch-sbb:9876")).toBe(true);
    });

    it("returns false for db: prefixed IDs", async () => {
      const { isGtfsLocalId } = await loadModule();
      expect(isGtfsLocalId("db:1234")).toBe(false);
    });

    it("returns false for mo: prefixed IDs", async () => {
      const { isGtfsLocalId } = await loadModule();
      expect(isGtfsLocalId("mo:abc")).toBe(false);
    });

    it("returns false for plain IDs with no prefix", async () => {
      const { isGtfsLocalId } = await loadModule();
      expect(isGtfsLocalId("1234")).toBe(false);
      expect(isGtfsLocalId("stop:1234")).toBe(false);
    });
  });

  // hasCoverage

  describe("hasCoverage", () => {
    it("returns true when active feeds cover the bbox", async () => {
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([makeFeed("de-nrw", "gtfs_de_nrw")]);

      const { hasCoverage } = await loadModule();
      const result = hasCoverage([6.0, 50.0, 9.0, 52.0]);

      expect(result).toBe(true);
      expect(mockGtfsManager.getActiveFeedsForBbox).toHaveBeenCalledWith([6.0, 50.0, 9.0, 52.0]);
    });

    it("returns false when no feeds cover the bbox", async () => {
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([]);

      const { hasCoverage } = await loadModule();
      expect(hasCoverage([100.0, 0.0, 110.0, 10.0])).toBe(false);
    });

    it("returns false when manager is not initialized", async () => {
      mockGtfsManager.initialized = false;

      const { hasCoverage } = await loadModule();
      expect(hasCoverage([6.0, 50.0, 9.0, 52.0])).toBe(false);
    });
  });

  // getStops

  describe("getStops", () => {
    it("returns empty array when manager is not initialized", async () => {
      mockGtfsManager.initialized = false;

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops).toEqual([]);
      expect(mockGtfsManager.getActiveFeedsForBbox).not.toHaveBeenCalled();
    });

    it("returns empty array when no feeds cover the bbox", async () => {
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops).toEqual([]);
      expect(mockGetStopsInBbox).not.toHaveBeenCalled();
    });

    it("returns stops with g- prefixed IDs, correct lat/lng, modes, and provider", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      mockGetStopsInBbox.mockResolvedValue([makeStopRow()]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("g-de-nrw:1234");
      expect(stops[0].name).toBe("Test Stop");
      expect(stops[0].lat).toBe(51.5);
      expect(stops[0].lng).toBe(7.2);
      expect(stops[0].modes).toEqual(["bus"]);
      expect(stops[0].provider).toBe("gtfs-de-nrw");
    });

    it("maps route_types to correct transport modes", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      mockGetStopsInBbox.mockResolvedValue([
        makeStopRow({ route_types: [0, 1, 2] }), // tram, subway, rail
      ]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops[0].modes).toContain("tram");
      expect(stops[0].modes).toContain("subway");
      expect(stops[0].modes).toContain("rail");
      expect(stops[0].modes).not.toContain("bus");
    });

    it("defaults to bus when route_types is null", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      mockGetStopsInBbox.mockResolvedValue([makeStopRow({ route_types: null })]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops[0].modes).toEqual(["bus"]);
    });

    it("deduplicates modes when multiple route_types map to the same mode", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      // Both 3 and 11 map to "bus"
      mockGetStopsInBbox.mockResolvedValue([makeStopRow({ route_types: [3, 11] })]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops[0].modes).toEqual(["bus"]); // deduplicated
    });

    it("queries each feed separately and combines results", async () => {
      const feed1 = makeFeed("de-nrw", "gtfs_de_nrw");
      const feed2 = makeFeed("de-bav", "gtfs_de_bav");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed1, feed2]);

      const stopRow1 = makeStopRow({ stop_id: "100", stop_name: "NRW Stop" });
      const stopRow2 = makeStopRow({ stop_id: "200", stop_name: "Bavaria Stop" });

      mockGetStopsInBbox.mockResolvedValueOnce([stopRow1]).mockResolvedValueOnce([stopRow2]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 47.0, 15.0, 55.0]);

      expect(stops).toHaveLength(2);
      expect(mockGetStopsInBbox).toHaveBeenCalledTimes(2);
      expect(mockGetStopsInBbox).toHaveBeenCalledWith("gtfs_de_nrw", [6.0, 47.0, 15.0, 55.0], 200);
      expect(mockGetStopsInBbox).toHaveBeenCalledWith("gtfs_de_bav", [6.0, 47.0, 15.0, 55.0], 200);

      expect(stops[0].id).toBe("g-de-nrw:100");
      expect(stops[0].provider).toBe("gtfs-de-nrw");
      expect(stops[1].id).toBe("g-de-bav:200");
      expect(stops[1].provider).toBe("gtfs-de-bav");
    });

    it("returns partial results when one feed query throws", async () => {
      const feed1 = makeFeed("de-nrw", "gtfs_de_nrw");
      const feed2 = makeFeed("de-bav", "gtfs_de_bav");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed1, feed2]);

      mockGetStopsInBbox
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValueOnce([makeStopRow({ stop_id: "200" })]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 47.0, 15.0, 55.0]);

      // Second feed still returns its stop
      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("g-de-bav:200");
    });

    it("includes parentStationId when stop has parent_station", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      mockGetStopsInBbox.mockResolvedValue([
        makeStopRow({ stop_id: "platform_1", parent_station: "station_A" }),
      ]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops[0].parentStationId).toBe("g-de-nrw:station_A");
    });

    it("includes platformCode when stop has platform_code", async () => {
      const feed = makeFeed("de-nrw", "gtfs_de_nrw");
      mockGtfsManager.getActiveFeedsForBbox.mockReturnValue([feed]);
      mockGetStopsInBbox.mockResolvedValue([makeStopRow({ platform_code: "3" })]);

      const { getStops } = await loadModule();
      const stops = await getStops([6.0, 50.0, 9.0, 52.0]);

      expect(stops[0].platformCode).toBe("3");
    });
  });

  // getStopById

  describe("getStopById", () => {
    it("returns null when schema cannot be resolved (non-gtfs ID)", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue(null);
      mockGtfsManager.getOriginalStopId.mockReturnValue(null);
      mockGtfsManager.getSlugFromStopId.mockReturnValue(null);

      const { getStopById } = await loadModule();
      const stop = await getStopById("db:1234");

      expect(stop).toBeNull();
      expect(mockGetStopById).not.toHaveBeenCalled();
    });

    it("resolves and returns a stop from its prefixed ID", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("1234");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetStopById.mockResolvedValue(makeStopRow());

      const { getStopById } = await loadModule();
      const stop = await getStopById("g-de-nrw:1234");

      expect(stop).not.toBeNull();
      // ID preserved as the prefixed version passed in
      expect(stop?.id).toBe("g-de-nrw:1234");
      expect(stop?.name).toBe("Test Stop");
      expect(stop?.lat).toBe(51.5);
      expect(stop?.lng).toBe(7.2);
      expect(stop?.provider).toBe("gtfs-de-nrw");
    });

    it("calls query with correct schema and original ID", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("5678");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetStopById.mockResolvedValue(makeStopRow({ stop_id: "5678" }));

      const { getStopById } = await loadModule();
      await getStopById("g-de-nrw:5678");

      expect(mockGetStopById).toHaveBeenCalledWith("gtfs_de_nrw", "5678");
    });

    it("returns null when the query returns no row", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("9999");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetStopById.mockResolvedValue(null);

      const { getStopById } = await loadModule();
      const stop = await getStopById("g-de-nrw:9999");

      expect(stop).toBeNull();
    });

    it("returns null when the query throws", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("1234");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetStopById.mockRejectedValue(new Error("DB error"));

      const { getStopById } = await loadModule();
      const stop = await getStopById("g-de-nrw:1234");

      expect(stop).toBeNull();
    });
  });

  // searchByName

  describe("searchByName", () => {
    it("returns empty array when manager is not initialized", async () => {
      mockGtfsManager.initialized = false;

      const { searchByName } = await loadModule();
      const results = await searchByName("Hbf");

      expect(results).toEqual([]);
      expect(mockGtfsManager.getFeeds).not.toHaveBeenCalled();
    });

    it("returns empty array when no active feeds", async () => {
      mockGtfsManager.getFeeds.mockReturnValue([
        { ...makeFeed("de-nrw", "gtfs_de_nrw"), status: "failed" },
      ]);

      const { searchByName } = await loadModule();
      const results = await searchByName("Hbf");

      expect(results).toEqual([]);
      expect(mockSearchStopsByName).not.toHaveBeenCalled();
    });

    it("searches across all active feeds and returns prefixed stops", async () => {
      mockGtfsManager.getFeeds.mockReturnValue([
        makeFeed("de-nrw", "gtfs_de_nrw"),
        makeFeed("de-bav", "gtfs_de_bav"),
      ]);

      mockSearchStopsByName
        .mockResolvedValueOnce([makeStopRow({ stop_id: "hbf_nrw", stop_name: "Hbf NRW" })])
        .mockResolvedValueOnce([makeStopRow({ stop_id: "hbf_bav", stop_name: "Hbf Bavaria" })]);

      const { searchByName } = await loadModule();
      const results = await searchByName("Hbf");

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("g-de-nrw:hbf_nrw");
      expect(results[1].id).toBe("g-de-bav:hbf_bav");
      expect(mockSearchStopsByName).toHaveBeenCalledTimes(2);
      expect(mockSearchStopsByName).toHaveBeenCalledWith("gtfs_de_nrw", "Hbf", 20);
      expect(mockSearchStopsByName).toHaveBeenCalledWith("gtfs_de_bav", "Hbf", 20);
    });

    it("passes custom limit to the query", async () => {
      mockGtfsManager.getFeeds.mockReturnValue([makeFeed("de-nrw", "gtfs_de_nrw")]);
      mockSearchStopsByName.mockResolvedValue([]);

      const { searchByName } = await loadModule();
      await searchByName("Hbf", 5);

      expect(mockSearchStopsByName).toHaveBeenCalledWith("gtfs_de_nrw", "Hbf", 5);
    });

    it("returns partial results when one feed throws", async () => {
      mockGtfsManager.getFeeds.mockReturnValue([
        makeFeed("de-nrw", "gtfs_de_nrw"),
        makeFeed("de-bav", "gtfs_de_bav"),
      ]);

      mockSearchStopsByName
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValueOnce([makeStopRow({ stop_id: "ok_stop" })]);

      const { searchByName } = await loadModule();
      const results = await searchByName("test");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("g-de-bav:ok_stop");
    });
  });

  // getDepartures

  describe("getDepartures", () => {
    it("returns empty array when schema cannot be resolved", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue(null);
      mockGtfsManager.getOriginalStopId.mockReturnValue(null);
      mockGtfsManager.getSlugFromStopId.mockReturnValue(null);

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("db:1234", 30);

      expect(deps).toEqual([]);
      expect(mockGetDepartures).not.toHaveBeenCalled();
    });

    it("extracts slug and raw ID from prefixed stop ID", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockResolvedValue([]);

      const { getDepartures } = await loadModule();
      await getDepartures("g-de-nrw:stop_001", 30);

      expect(mockGetDepartures).toHaveBeenCalledWith("gtfs_de_nrw", "stop_001", 30);
    });

    it("maps departure rows with prefixed tripId, routeId, and correct mode", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockResolvedValue([makeDepartureRow()]);

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("g-de-nrw:stop_001", 30);

      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("g-de-nrw:trip_abc");
      expect(deps[0].route.id).toBe("g-de-nrw:route_01");
      expect(deps[0].route.shortName).toBe("RE 1");
      expect(deps[0].route.longName).toBe("Regional Express 1");
      expect(deps[0].route.mode).toBe("rail");
      expect(deps[0].route.color).toBe("FF0000"); // # stripped
      expect(deps[0].headsign).toBe("Dortmund Hbf");
      expect(deps[0].scheduledAt).toBe("2026-03-10T10:30:00Z");
      expect(deps[0].canceled).toBe(false);
    });

    it("strips leading # from route_color", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockResolvedValue([makeDepartureRow({ route_color: "#0055AA" })]);

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("g-de-nrw:stop_001", 30);

      expect(deps[0].route.color).toBe("0055AA");
    });

    it("handles null route_color gracefully", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockResolvedValue([makeDepartureRow({ route_color: null })]);

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("g-de-nrw:stop_001", 30);

      expect(deps[0].route.color).toBeUndefined();
    });

    it("uses t_departure as scheduledAt", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockResolvedValue([
        makeDepartureRow({ t_departure: "2026-03-10T14:00:00Z" }),
      ]);

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("g-de-nrw:stop_001", 60);

      expect(deps[0].scheduledAt).toBe("2026-03-10T14:00:00Z");
    });

    it("returns empty array when query throws", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDepartures.mockRejectedValue(new Error("DB error"));

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("g-de-nrw:stop_001", 30);

      expect(deps).toEqual([]);
    });
  });

  // getArrivals

  describe("getArrivals", () => {
    it("returns empty array when schema cannot be resolved", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue(null);
      mockGtfsManager.getOriginalStopId.mockReturnValue(null);
      mockGtfsManager.getSlugFromStopId.mockReturnValue(null);

      const { getArrivals } = await loadModule();
      const arrivals = await getArrivals("db:1234", 30);

      expect(arrivals).toEqual([]);
    });

    it("maps arrival rows using t_arrival as scheduledAt", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetArrivals.mockResolvedValue([
        makeDepartureRow({ t_arrival: "2026-03-10T11:00:00Z", t_departure: undefined }),
      ]);

      const { getArrivals } = await loadModule();
      const arrivals = await getArrivals("g-de-nrw:stop_001", 30);

      expect(arrivals).toHaveLength(1);
      expect(arrivals[0].scheduledAt).toBe("2026-03-10T11:00:00Z");
      expect(arrivals[0].tripId).toBe("g-de-nrw:trip_abc");
    });

    it("calls getArrivals query with correct parameters", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetArrivals.mockResolvedValue([]);

      const { getArrivals } = await loadModule();
      await getArrivals("g-de-nrw:stop_001", 45);

      expect(mockGetArrivals).toHaveBeenCalledWith("gtfs_de_nrw", "stop_001", 45);
    });
  });

  // getTimetable

  describe("getTimetable", () => {
    it("returns empty array when schema cannot be resolved", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue(null);
      mockGtfsManager.getOriginalStopId.mockReturnValue(null);
      mockGtfsManager.getSlugFromStopId.mockReturnValue(null);

      const { getTimetable } = await loadModule();
      const rows = await getTimetable("db:1234", "2026-03-10");

      expect(rows).toEqual([]);
      expect(mockGetDeparturesByDate).not.toHaveBeenCalled();
    });

    it("calls getDeparturesByDate with schema, rawId, and date", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDeparturesByDate.mockResolvedValue([]);

      const { getTimetable } = await loadModule();
      await getTimetable("g-de-nrw:stop_001", "2026-03-10");

      expect(mockGetDeparturesByDate).toHaveBeenCalledWith("gtfs_de_nrw", "stop_001", "2026-03-10");
    });

    it("maps timetable rows to Departure objects with prefixed IDs", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDeparturesByDate.mockResolvedValue([
        makeDepartureRow({ t_departure: "2026-03-10T08:00:00Z" }),
        makeDepartureRow({ trip_id: "trip_xyz", t_departure: "2026-03-10T09:00:00Z" }),
      ]);

      const { getTimetable } = await loadModule();
      const rows = await getTimetable("g-de-nrw:stop_001", "2026-03-10");

      expect(rows).toHaveLength(2);
      expect(rows[0].tripId).toBe("g-de-nrw:trip_abc");
      expect(rows[0].scheduledAt).toBe("2026-03-10T08:00:00Z");
      expect(rows[1].tripId).toBe("g-de-nrw:trip_xyz");
      expect(rows[1].scheduledAt).toBe("2026-03-10T09:00:00Z");
    });

    it("returns empty array when query throws", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("stop_001");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetDeparturesByDate.mockRejectedValue(new Error("DB error"));

      const { getTimetable } = await loadModule();
      const rows = await getTimetable("g-de-nrw:stop_001", "2026-03-10");

      expect(rows).toEqual([]);
    });
  });

  // getPlatformStops

  describe("getPlatformStops", () => {
    it("returns empty array when schema cannot be resolved", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue(null);
      mockGtfsManager.getOriginalStopId.mockReturnValue(null);
      mockGtfsManager.getSlugFromStopId.mockReturnValue(null);

      const { getPlatformStops } = await loadModule();
      const platforms = await getPlatformStops("db:1234");

      expect(platforms).toEqual([]);
      expect(mockGetChildStops).not.toHaveBeenCalled();
    });

    it("calls getChildStops with correct schema and parent stop ID", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("station_A");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetChildStops.mockResolvedValue([]);

      const { getPlatformStops } = await loadModule();
      await getPlatformStops("g-de-nrw:station_A");

      expect(mockGetChildStops).toHaveBeenCalledWith("gtfs_de_nrw", "station_A");
    });

    it("returns child stops with prefixed IDs and parentStationId", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("station_A");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetChildStops.mockResolvedValue([
        makeStopRow({
          stop_id: "platform_1",
          stop_name: "Platform 1",
          parent_station: "station_A",
          platform_code: "1",
        }),
        makeStopRow({
          stop_id: "platform_2",
          stop_name: "Platform 2",
          parent_station: "station_A",
          platform_code: "2",
        }),
      ]);

      const { getPlatformStops } = await loadModule();
      const platforms = await getPlatformStops("g-de-nrw:station_A");

      expect(platforms).toHaveLength(2);
      expect(platforms[0].id).toBe("g-de-nrw:platform_1");
      expect(platforms[0].name).toBe("Platform 1");
      expect(platforms[0].parentStationId).toBe("g-de-nrw:station_A");
      expect(platforms[0].platformCode).toBe("1");
      expect(platforms[0].provider).toBe("gtfs-de-nrw");

      expect(platforms[1].id).toBe("g-de-nrw:platform_2");
      expect(platforms[1].parentStationId).toBe("g-de-nrw:station_A");
      expect(platforms[1].platformCode).toBe("2");
    });

    it("returns empty array when query throws", async () => {
      mockGtfsManager.getSchemaForStopId.mockReturnValue("gtfs_de_nrw");
      mockGtfsManager.getOriginalStopId.mockReturnValue("station_A");
      mockGtfsManager.getSlugFromStopId.mockReturnValue("de-nrw");
      mockGetChildStops.mockRejectedValue(new Error("DB error"));

      const { getPlatformStops } = await loadModule();
      const platforms = await getPlatformStops("g-de-nrw:station_A");

      expect(platforms).toEqual([]);
    });
  });
});
