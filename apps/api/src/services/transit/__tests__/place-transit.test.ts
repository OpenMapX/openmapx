import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock cache (always miss so business logic runs)

vi.mock("../cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheKey: vi.fn((_type: string, _params: unknown) => "test-cache-key"),
  TTL: {
    placeStops: 86400,
    placeRoutes: 300,
    placeAlerts: 60,
    placeFacilities: 86400,
  },
}));

// Mock transit index functions
// NOTE: vi.mock factories are hoisted to the top of the file by Vitest.
// Variables declared in the test file (outside the factory) are NOT yet
// initialized when the factory runs, so we cannot reference them here.
// Instead we declare mocks inline and import them afterwards.

vi.mock("../index.js", () => ({
  fetchStopsByNameRaw: vi.fn(),
  getRoutesForStop: vi.fn(),
  getStopDepartures: vi.fn(),
  getStopArrivals: vi.fn(),
  getStopAlerts: vi.fn(),
  getFacilities: vi.fn(),
}));

// Import after mocks

import {
  fetchStopsByNameRaw,
  getFacilities,
  getRoutesForStop,
  getStopAlerts,
  getStopDepartures,
} from "../index.js";

import {
  getLinkedStops,
  getMergedAlerts,
  getMergedDepartures,
  getMergedFacilities,
  getMergedRoutes,
} from "../place-transit.js";
import type { MergedDeparture, ServiceAlert, TransitStop } from "../types.js";

// Helpers

function makeStop(
  id: string,
  name: string,
  lat: number,
  lng: number,
  provider = "transitous",
): TransitStop {
  return { id, name, lat, lng, modes: ["rail"], provider };
}

function makeDeparture(
  shortName: string,
  scheduledAt: string,
  extra: Partial<MergedDeparture> = {},
): MergedDeparture {
  return {
    tripId: `trip:${shortName}`,
    route: { id: `r:${shortName}`, shortName, longName: shortName, mode: "rail" },
    headsign: "Destination",
    scheduledAt,
    canceled: false,
    providers: ["transitous"],
    ...extra,
  };
}

function makeAlert(id: string, providers: string[]): ServiceAlert {
  return {
    id,
    providers,
    severity: "warning",
    title: `Alert ${id}`,
    affectedRouteIds: [],
    affectedStopIds: [],
    activePeriods: [],
  };
}

// Tests

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// getLinkedStops

describe("getLinkedStops", () => {
  it("returns stops within 1 km with name similarity >= 0.4", async () => {
    // Stop very close to the place with matching name
    const nearby = makeStop("mo:de_berlin", "Berlin Hbf", 52.526, 13.37); // ~100m away
    // Stop too far away (> 1 km)
    const farAway = makeStop("mo:de_far", "Berlin Far", 52.6, 13.37);
    // Stop nearby but name doesn't match at all
    const wrongName = makeStop("mo:de_other", "Hamburg Airport", 52.526, 13.371);

    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([nearby, farAway, wrongName]);

    const result = await getLinkedStops(52.525, 13.369, "Berlin Hauptbahnhof");

    // Only the nearby+name-matching stop should pass
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mo:de_berlin");
  });

  it("returns empty array when no stops match name+distance criteria", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([
      makeStop("mo:de_far", "Munich Hbf", 48.14, 11.558), // far from Berlin coords
    ]);

    const result = await getLinkedStops(52.525, 13.369, "Berlin Hbf");
    expect(result).toHaveLength(0);
  });

  it("calls fetchStopsByNameRaw with name and limit 30", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([]);

    await getLinkedStops(52.525, 13.369, "Berlin Hbf");

    expect(fetchStopsByNameRaw).toHaveBeenCalledTimes(1);
    const [name, limit] = vi.mocked(fetchStopsByNameRaw).mock.calls[0];
    expect(name).toBe("Berlin Hbf");
    expect(limit).toBe(30);
  });
});

// getMergedRoutes

describe("getMergedRoutes", () => {
  it("returns empty array when no stops are linked", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([]);

    const result = await getMergedRoutes(52.525, 13.369, "Berlin Hbf");
    expect(result).toEqual([]);
    expect(getRoutesForStop).not.toHaveBeenCalled();
  });

  it("merges routes from multiple stops and deduplicates by mode+shortName", async () => {
    const stop1 = makeStop("mo:de_berlin", "Berlin Hbf", 52.526, 13.37, "transitous");
    const stop2 = makeStop("db:berlin", "Berlin Hbf", 52.525, 13.369, "db");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop1, stop2]);

    // Both stops report the same ICE route under different IDs
    const iceRoute1 = {
      id: "mo:ice1",
      shortName: "ICE 1",
      longName: "ICE Berlin-Hamburg",
      mode: "rail" as const,
      operatorName: "DB",
    };
    const iceRoute2 = {
      id: "db:ice1",
      shortName: "ICE 1",
      longName: "ICE Berlin-Hamburg",
      mode: "rail" as const,
      color: "FF0000",
      operatorName: "DB",
    };
    // A unique route only in stop2
    const rbRoute = {
      id: "db:rb10",
      shortName: "RB10",
      longName: "Regional Express",
      mode: "rail" as const,
      operatorName: "DB",
    };

    vi.mocked(getRoutesForStop).mockResolvedValueOnce([iceRoute1]);
    vi.mocked(getRoutesForStop).mockResolvedValueOnce([iceRoute2, rbRoute]);

    const result = await getMergedRoutes(52.525, 13.369, "Berlin Hbf");

    // ICE should be deduplicated into one entry with both providers
    const ice = result.find((r) => r.shortName === "ICE 1");
    expect(ice).toBeDefined();
    expect(ice?.providers).toContain("transitous");
    expect(ice?.providers).toContain("db");
    // Color should be picked up from stop2's entry (which has color data)
    expect(ice?.color).toBe("FF0000");

    // RB10 should appear once with only "db" as provider
    const rb = result.find((r) => r.shortName === "RB10");
    expect(rb).toBeDefined();
    expect(rb?.providers).toEqual(["db"]);
  });
});

// getMergedDepartures

describe("getMergedDepartures", () => {
  it("returns empty array when no linked stops", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([]);

    const result = await getMergedDepartures(52.525, 13.369, "Berlin Hbf", 60);
    expect(result).toEqual([]);
  });

  it("deduplicates same departure from two providers using shortName+scheduledAt key", async () => {
    const stop1 = makeStop("mo:de_berlin", "Berlin Hbf", 52.526, 13.37, "transitous");
    const stop2 = makeStop("db:berlin", "Berlin Hbf", 52.525, 13.369, "db");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop1, stop2]);

    const scheduledAt = "2026-03-10T12:00:00Z";

    // Same ICE departure reported by both providers
    const dep1 = makeDeparture("ICE 1", scheduledAt, { providers: ["transitous"] });
    const dep2 = makeDeparture("ICE 1", scheduledAt, { providers: ["db"], platform: "5" });

    vi.mocked(getStopDepartures).mockResolvedValueOnce([dep1]);
    vi.mocked(getStopDepartures).mockResolvedValueOnce([dep2]);

    const result = await getMergedDepartures(52.525, 13.369, "Berlin Hbf", 60);

    // Should have exactly 1 merged departure (not 2)
    expect(result).toHaveLength(1);
    // Both providers should be listed
    expect(result[0].providers).toContain("transitous");
    expect(result[0].providers).toContain("db");
    // Platform from second provider should be merged in
    expect(result[0].platform).toBe("5");
  });

  it("keeps separate departures with different shortName or scheduledAt", async () => {
    const stop = makeStop("mo:de_berlin", "Berlin Hbf", 52.526, 13.37, "transitous");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop]);

    // Different routes to different destinations at the same time — should NOT merge
    // because shortNames differ and headsigns also differ (preventing k3 collision)
    const dep1 = makeDeparture("ICE 1", "2026-03-10T12:00:00Z", {
      providers: ["transitous"],
      headsign: "Hamburg Hbf",
    });
    const dep2 = makeDeparture("ICE 2", "2026-03-10T12:00:00Z", {
      providers: ["transitous"],
      headsign: "München Hbf",
    }); // different route+destination
    const dep3 = makeDeparture("ICE 1", "2026-03-10T13:00:00Z", {
      providers: ["transitous"],
      headsign: "Hamburg Hbf",
    }); // same route, different time

    vi.mocked(getStopDepartures).mockResolvedValueOnce([dep1, dep2, dep3]);

    const result = await getMergedDepartures(52.525, 13.369, "Berlin Hbf", 60);

    expect(result).toHaveLength(3);
  });

  it("sorts departures by scheduledAt ascending", async () => {
    const stop = makeStop("mo:de_berlin", "Berlin Hbf", 52.526, 13.37, "transitous");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop]);

    const dep1 = makeDeparture("ICE 1", "2026-03-10T14:00:00Z", { providers: ["transitous"] });
    const dep2 = makeDeparture("ICE 2", "2026-03-10T12:00:00Z", { providers: ["transitous"] });
    const dep3 = makeDeparture("RB10", "2026-03-10T13:00:00Z", { providers: ["transitous"] });

    vi.mocked(getStopDepartures).mockResolvedValueOnce([dep1, dep2, dep3]);

    const result = await getMergedDepartures(52.525, 13.369, "Berlin Hbf", 60);

    expect(result[0].scheduledAt).toBe("2026-03-10T12:00:00Z");
    expect(result[1].scheduledAt).toBe("2026-03-10T13:00:00Z");
    expect(result[2].scheduledAt).toBe("2026-03-10T14:00:00Z");
  });
});

// getMergedAlerts

describe("getMergedAlerts", () => {
  it("returns empty array when no linked stops", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([]);

    const result = await getMergedAlerts(52.525, 13.369, "Berlin Hbf");
    expect(result).toEqual([]);
  });

  it("deduplicates alerts with same id across stops", async () => {
    const stop1 = makeStop("mo:de_berlin_1", "Berlin Hbf", 52.526, 13.37, "transitous");
    const stop2 = makeStop("mo:de_berlin_2", "Berlin Hbf", 52.525, 13.369, "transitous");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop1, stop2]);

    const alert = makeAlert("alert:1", ["transitous"]);
    // Same alert from both stops
    vi.mocked(getStopAlerts).mockResolvedValueOnce([alert]);
    vi.mocked(getStopAlerts).mockResolvedValueOnce([alert]);

    const result = await getMergedAlerts(52.525, 13.369, "Berlin Hbf");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("alert:1");
  });
});

// getMergedFacilities

describe("getMergedFacilities", () => {
  it("returns empty array when no linked stops", async () => {
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([]);

    const result = await getMergedFacilities(52.525, 13.369, "Berlin Hbf");
    expect(result).toEqual([]);
  });

  it("deduplicates facilities with same id across stops", async () => {
    const stop1 = makeStop("mo:de_berlin_1", "Berlin Hbf", 52.526, 13.37, "transitous");
    const stop2 = makeStop("mo:de_berlin_2", "Berlin Hbf", 52.525, 13.369, "transitous");
    vi.mocked(fetchStopsByNameRaw).mockResolvedValue([stop1, stop2]);

    const facility = {
      id: "fac:elevator1",
      stopId: "mo:de_berlin_1",
      name: "Main Elevator",
      type: "elevator" as const,
      isAccessible: true,
      provider: "transitous",
    };
    vi.mocked(getFacilities).mockResolvedValueOnce([facility]);
    vi.mocked(getFacilities).mockResolvedValueOnce([facility]);

    const result = await getMergedFacilities(52.525, 13.369, "Berlin Hbf");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("fac:elevator1");
  });
});
