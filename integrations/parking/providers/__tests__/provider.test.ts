import type { BoundingBox, DataSourceResult, ParkingFacility } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db-bahnpark.js", () => ({
  searchDbBahnPark: vi.fn(),
  fetchDbBahnParkDetail: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  deduplicateParking: vi.fn((items: unknown[]) => items),
}));

vi.mock("../mapper.js", () => ({
  mapParkingToResult: vi.fn(),
  mapParkingToDetail: vi.fn(),
}));

vi.mock("../osm.js", () => ({
  searchOsmParking: vi.fn(),
  fetchOsmParkingElement: vi.fn(),
}));

vi.mock("../parkapi-v2.js", () => ({
  searchParkApiV2: vi.fn(),
  fetchParkApiV2Detail: vi.fn(),
}));

vi.mock("../parkapi-v3.js", () => ({
  searchParkApiV3: vi.fn(),
  fetchParkApiV3Detail: vi.fn(),
}));

import { fetchDbBahnParkDetail, searchDbBahnPark } from "../db-bahnpark.js";
import { deduplicateParking } from "../dedup.js";
import { mapParkingToDetail, mapParkingToResult } from "../mapper.js";
import { fetchOsmParkingElement, searchOsmParking } from "../osm.js";
import { fetchParkApiV2Detail, searchParkApiV2 } from "../parkapi-v2.js";
import { fetchParkApiV3Detail, searchParkApiV3 } from "../parkapi-v3.js";
import { parkingProvider } from "../provider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeFacility(overrides: Partial<ParkingFacility> = {}): ParkingFacility {
  return {
    id: overrides.id ?? "test-id",
    name: overrides.name ?? "Test Parking",
    coordinates: overrides.coordinates ?? [11.5, 48.5],
    source: overrides.source ?? "test",
    parkingType: overrides.parkingType ?? "garage",
    hasRealtimeData: overrides.hasRealtimeData ?? false,
    attribution: overrides.attribution ?? { label: "Test", url: "" },
    ...overrides,
  };
}

function makeResult(id: string): DataSourceResult {
  return {
    id,
    name: `Parking ${id}`,
    coordinates: [11.5, 48.5],
    source: "parking",
    variant: "unknown",
    status: "unknown",
  };
}

function setupEmptySources() {
  vi.mocked(searchParkApiV2).mockResolvedValue([]);
  vi.mocked(searchParkApiV3).mockResolvedValue([]);
  vi.mocked(searchDbBahnPark).mockResolvedValue([]);
  vi.mocked(searchOsmParking).mockResolvedValue([]);
}

// Meta

describe("parkingProvider meta", () => {
  it("has id 'parking'", () => {
    expect(parkingProvider.id).toBe("parking");
  });

  it("meta includes expected attribution sources", () => {
    const attr = parkingProvider.meta.attribution;
    expect(Array.isArray(attr)).toBe(true);
    const texts = (attr as Array<{ text: string }>).map((a) => a.text);
    expect(texts).toContain("ParkenDD");
    expect(texts).toContain("DB BahnPark");
    expect(texts).toContain("OpenStreetMap");
  });
});

// search()

describe("parkingProvider.search", () => {
  it("queries 4 sources in parallel and combines in priority order DB > v3 > v2 > OSM", async () => {
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
    const db = [makeFacility({ id: "db-bahnpark:1", source: "db" })];
    const v3 = [makeFacility({ id: "parkapi-v3:2", source: "v3" })];
    const v2 = [makeFacility({ id: "parkapi-v2:city/3", source: "v2" })];
    const osm = [makeFacility({ id: "osm:node/4", source: "osm" })];

    vi.mocked(searchParkApiV2).mockResolvedValue(v2);
    vi.mocked(searchParkApiV3).mockResolvedValue(v3);
    vi.mocked(searchDbBahnPark).mockResolvedValue(db);
    vi.mocked(searchOsmParking).mockResolvedValue(osm);

    const results = await parkingProvider.search(makeBbox());

    // Verify priority order passed to dedup: DB first, then v3, v2, OSM
    const dedupCall = vi.mocked(deduplicateParking).mock.calls[0][0];
    expect(dedupCall[0].id).toBe("db-bahnpark:1");
    expect(dedupCall[1].id).toBe("parkapi-v3:2");
    expect(dedupCall[2].id).toBe("parkapi-v2:city/3");
    expect(dedupCall[3].id).toBe("osm:node/4");
    expect(results).toHaveLength(4);
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
    vi.mocked(searchParkApiV2).mockRejectedValue(new Error("v2 down"));
    vi.mocked(searchParkApiV3).mockRejectedValue(new Error("v3 down"));
    vi.mocked(searchDbBahnPark).mockResolvedValue([makeFacility({ id: "db:1" })]);
    vi.mocked(searchOsmParking).mockRejectedValue(new Error("osm down"));

    const results = await parkingProvider.search(makeBbox());

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("db:1");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(searchParkApiV2).mockRejectedValue(new Error("down"));
    vi.mocked(searchParkApiV3).mockRejectedValue(new Error("down"));
    vi.mocked(searchDbBahnPark).mockRejectedValue(new Error("down"));
    vi.mocked(searchOsmParking).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateParking).mockReturnValue([]);

    const results = await parkingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });
});

// Filters

describe("parkingProvider.search filters", () => {
  function setupSources(facilities: ParkingFacility[]) {
    vi.mocked(searchParkApiV2).mockResolvedValue([]);
    vi.mocked(searchParkApiV3).mockResolvedValue([]);
    vi.mocked(searchDbBahnPark).mockResolvedValue([]);
    vi.mocked(searchOsmParking).mockResolvedValue(facilities);
    vi.mocked(deduplicateParking).mockReturnValue(facilities);
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
  }

  it("parkingType filter: only matching types returned", async () => {
    const facilities = [
      makeFacility({ id: "pt-a", parkingType: "garage" }),
      makeFacility({ id: "pt-b", parkingType: "surface" }),
      makeFacility({ id: "pt-c", parkingType: "underground" }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), {
      parkingType: ["garage", "underground"],
    });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["pt-a", "pt-c"]);
  });

  it("fee filter: only paid or free returned", async () => {
    const facilities = [
      makeFacility({ id: "fee-a", fee: "free" }),
      makeFacility({ id: "fee-b", fee: "paid" }),
      makeFacility({ id: "fee-c", fee: undefined }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), { fee: "free" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fee-a");
  });

  it("availability 'available' excludes freeSpaces=0 with realtime data", async () => {
    const facilities = [
      makeFacility({ id: "av-a", hasRealtimeData: true, freeSpaces: 10 }),
      makeFacility({ id: "av-b", hasRealtimeData: true, freeSpaces: 0 }),
      makeFacility({ id: "av-c", hasRealtimeData: false, freeSpaces: undefined }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), { availability: "available" });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["av-a", "av-c"]);
  });

  it("availability 'available' + 'full' includes all", async () => {
    const facilities = [
      makeFacility({ id: "af-a", hasRealtimeData: true, freeSpaces: 10 }),
      makeFacility({ id: "af-b", hasRealtimeData: true, freeSpaces: 0 }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), {
      availability: ["available", "full"],
    });

    expect(results).toHaveLength(2);
  });

  it("features 'disabled' filters to facilities with disabledSpaces > 0", async () => {
    const facilities = [
      makeFacility({ id: "fd-a", disabledSpaces: 5 }),
      makeFacility({ id: "fd-b", disabledSpaces: 0 }),
      makeFacility({ id: "fd-c" }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), { features: "disabled" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fd-a");
  });

  it("features 'ev-charging' filters to facilities with chargingSpaces > 0", async () => {
    const facilities = [
      makeFacility({ id: "fe-a", chargingSpaces: 2 }),
      makeFacility({ id: "fe-b", chargingSpaces: 0 }),
      makeFacility({ id: "fe-c" }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), { features: "ev-charging" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fe-a");
  });

  it("features 'park-and-ride' filters to parkAndRide=true", async () => {
    const facilities = [
      makeFacility({ id: "fp-a", parkAndRide: true }),
      makeFacility({ id: "fp-b", parkAndRide: false }),
      makeFacility({ id: "fp-c" }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), { features: "park-and-ride" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fp-a");
  });

  it("multiple features combined: all must match", async () => {
    const facilities = [
      makeFacility({ id: "fm-a", disabledSpaces: 3, chargingSpaces: 2 }),
      makeFacility({ id: "fm-b", disabledSpaces: 5, chargingSpaces: 0 }),
      makeFacility({ id: "fm-c", disabledSpaces: 0, chargingSpaces: 4 }),
    ];
    setupSources(facilities);

    const results = await parkingProvider.search(makeBbox(), {
      features: ["disabled", "ev-charging"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fm-a");
  });
});

// getDetail()

describe("parkingProvider.getDetail", () => {
  it("cache hit returns mapped detail", async () => {
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
    const facility = makeFacility({ id: "pk-cached-1" });
    vi.mocked(searchParkApiV2).mockResolvedValue([]);
    vi.mocked(searchParkApiV3).mockResolvedValue([]);
    vi.mocked(searchDbBahnPark).mockResolvedValue([facility]);
    vi.mocked(searchOsmParking).mockResolvedValue([]);
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    await parkingProvider.search(makeBbox());

    const detail = {
      id: "pk-cached-1",
      source: "db",
      name: "Parking",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "DB", url: "" },
      sections: [],
    };
    vi.mocked(mapParkingToDetail).mockReturnValue(detail);

    const result = await parkingProvider.getDetail("pk-cached-1");
    expect(mapParkingToDetail).toHaveBeenCalledWith(facility);
    expect(result).toBe(detail);
  });

  it("cache miss with parkapi-v2: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "parkapi-v2:berlin/lot42" });
    vi.mocked(fetchParkApiV2Detail).mockResolvedValue(facility);

    // Mock enrichFacility's internal calls
    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);

    const detail = {
      id: "parkapi-v2:berlin/lot42",
      source: "parkapi-v2",
      name: "Lot 42",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "ParkenDD", url: "" },
      sections: [],
    };
    vi.mocked(mapParkingToDetail).mockReturnValue(detail);

    const result = await parkingProvider.getDetail("parkapi-v2:berlin/lot42");
    expect(fetchParkApiV2Detail).toHaveBeenCalledWith("berlin", "lot42");
    expect(result).toBe(detail);
  });

  it("cache miss with parkapi-v3: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "parkapi-v3:123" });
    vi.mocked(fetchParkApiV3Detail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "parkapi-v3:123",
      source: "parkapi-v3",
      name: "P",
      coordinates: [0, 0],
      attribution: { text: "", url: "" },
      sections: [],
    });

    const result = await parkingProvider.getDetail("parkapi-v3:123");
    expect(fetchParkApiV3Detail).toHaveBeenCalledWith(123);
    expect(result.id).toBe("parkapi-v3:123");
  });

  it("cache miss with db-bahnpark: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "db-bahnpark:ABC" });
    vi.mocked(fetchDbBahnParkDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "db-bahnpark:ABC",
      source: "db",
      name: "P",
      coordinates: [0, 0],
      attribution: { text: "", url: "" },
      sections: [],
    });

    const result = await parkingProvider.getDetail("db-bahnpark:ABC");
    expect(fetchDbBahnParkDetail).toHaveBeenCalledWith("ABC");
    expect(result.id).toBe("db-bahnpark:ABC");
  });

  it("cache miss with osm: prefix fetches element", async () => {
    const facility = makeFacility({ id: "osm:way/999" });
    vi.mocked(fetchOsmParkingElement).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "osm:way/999",
      source: "osm",
      name: "P",
      coordinates: [0, 0],
      attribution: { text: "", url: "" },
      sections: [],
    });

    const result = await parkingProvider.getDetail("osm:way/999");
    expect(fetchOsmParkingElement).toHaveBeenCalledWith("way", 999);
    expect(result.id).toBe("osm:way/999");
  });

  it("unknown prefix returns fallback detail", async () => {
    const result = await parkingProvider.getDetail("xyz:totally-unknown-parking");
    expect(result.id).toBe("xyz:totally-unknown-parking");
    expect(result.source).toBe("unknown");
    expect(result.name).toBe("Parking");
    expect(result.coordinates).toEqual([0, 0]);
    expect(result.sections).toEqual([]);
  });
});
