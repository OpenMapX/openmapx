import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../apag.js", () => ({ searchApag: vi.fn(), fetchApagDetail: vi.fn() }));
vi.mock("../apcoa.js", () => ({ searchApcoa: vi.fn(), fetchApcoaDetail: vi.fn() }));
vi.mock("../autobahn-de.js", () => ({
  searchAutobahnDe: vi.fn(),
  fetchAutobahnDeDetail: vi.fn(),
}));
vi.mock("../barcelona-es.js", () => ({
  searchBarcelonaEs: vi.fn(),
  fetchBarcelonaEsDetail: vi.fn(),
}));
vi.mock("../basel-ch.js", () => ({ searchBaselCh: vi.fn(), fetchBaselChDetail: vi.fn() }));
vi.mock("../bnls-fr.js", () => ({ searchBnlsFr: vi.fn(), fetchBnlsFrDetail: vi.fn() }));
vi.mock("../brussels-be.js", () => ({ searchBrusselsBe: vi.fn(), fetchBrusselsBeDetail: vi.fn() }));
vi.mock("../cita-lu.js", () => ({ searchCitaLu: vi.fn(), fetchCitaLuDetail: vi.fn() }));
vi.mock("../copenhagen-dk.js", () => ({
  searchCopenhagenDk: vi.fn(),
  fetchCopenhagenDkDetail: vi.fn(),
}));
vi.mock("../db-bahnpark.js", () => ({ searchDbBahnPark: vi.fn(), fetchDbBahnParkDetail: vi.fn() }));
vi.mock("../dedup.js", () => ({ deduplicateParking: vi.fn((items: unknown[]) => items) }));
vi.mock("../florence-it.js", () => ({ searchFlorenceIt: vi.fn(), fetchFlorenceItDetail: vi.fn() }));
vi.mock("../ghent-be.js", () => ({ searchGhentBe: vi.fn(), fetchGhentBeDetail: vi.fn() }));
vi.mock("../goldbeck.js", () => ({ searchGoldbeck: vi.fn(), fetchGoldbeckDetail: vi.fn() }));
vi.mock("../madrid-es.js", () => ({ searchMadridEs: vi.fn(), fetchMadridEsDetail: vi.fn() }));
vi.mock("../ndw-truck-nl.js", () => ({
  searchNdwTruckNl: vi.fn(),
  fetchNdwTruckNlDetail: vi.fn(),
}));
vi.mock("../nrw-mobidrom.js", () => ({
  searchNrwMobidrom: vi.fn(),
  fetchNrwMobidromDetail: vi.fn(),
}));
vi.mock("../nrw-pr.js", () => ({
  searchNrwPr: vi.fn(),
  fetchNrwPrDetail: vi.fn(),
}));
vi.mock("../opendatahub-it.js", () => ({ searchOdhIt: vi.fn(), fetchOdhItDetail: vi.fn() }));
vi.mock("../mapper.js", () => ({ mapParkingToResult: vi.fn(), mapParkingToDetail: vi.fn() }));
vi.mock("../nsw-au.js", () => ({ searchNswAu: vi.fn(), fetchNswAuDetail: vi.fn() }));
vi.mock("../osm.js", () => ({ searchOsmParking: vi.fn(), fetchOsmParkingElement: vi.fn() }));
vi.mock("../parkapi-v2.js", () => ({ searchParkApiV2: vi.fn(), fetchParkApiV2Detail: vi.fn() }));
vi.mock("../parkapi-v3.js", () => ({ searchParkApiV3: vi.fn(), fetchParkApiV3Detail: vi.fn() }));
vi.mock("../rdw-nl.js", () => ({ searchRdwNl: vi.fn(), fetchRdwNlDetail: vi.fn() }));
vi.mock("../singapore.js", () => ({ searchSingapore: vi.fn(), fetchSingaporeDetail: vi.fn() }));
vi.mock("../utmc-newcastle.js", () => ({
  searchUtmcNewcastle: vi.fn(),
  fetchUtmcNewcastleDetail: vi.fn(),
}));
vi.mock("../vienna-at.js", () => ({ searchViennaAt: vi.fn(), fetchViennaAtDetail: vi.fn() }));

import { searchApag } from "../apag.js";
import { searchApcoa } from "../apcoa.js";
import { searchAutobahnDe } from "../autobahn-de.js";
import { searchBarcelonaEs } from "../barcelona-es.js";
import { searchBaselCh } from "../basel-ch.js";
import { fetchBnlsFrDetail, searchBnlsFr } from "../bnls-fr.js";
import { searchBrusselsBe } from "../brussels-be.js";
import { fetchCitaLuDetail, searchCitaLu } from "../cita-lu.js";
import { searchCopenhagenDk } from "../copenhagen-dk.js";
import { fetchDbBahnParkDetail, searchDbBahnPark } from "../db-bahnpark.js";
import { deduplicateParking } from "../dedup.js";
import { searchFlorenceIt } from "../florence-it.js";
import { searchGhentBe } from "../ghent-be.js";
import { searchGoldbeck } from "../goldbeck.js";
import { searchMadridEs } from "../madrid-es.js";
import { mapParkingToDetail, mapParkingToResult } from "../mapper.js";
import { searchNdwTruckNl } from "../ndw-truck-nl.js";
import { searchNrwMobidrom } from "../nrw-mobidrom.js";
import { searchNrwPr } from "../nrw-pr.js";
import { searchNswAu } from "../nsw-au.js";
import { searchOdhIt } from "../opendatahub-it.js";
import { fetchOsmParkingElement, searchOsmParking } from "../osm.js";
import { fetchParkApiV2Detail, searchParkApiV2 } from "../parkapi-v2.js";
import { fetchParkApiV3Detail, searchParkApiV3 } from "../parkapi-v3.js";
import { parkingProvider } from "../provider.js";
import { fetchRdwNlDetail, searchRdwNl } from "../rdw-nl.js";
import { searchSingapore } from "../singapore.js";
import { searchUtmcNewcastle } from "../utmc-newcastle.js";
import { searchViennaAt } from "../vienna-at.js";

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
    sources: overrides.sources ?? ["test"],
    parkingType: overrides.parkingType ?? "garage",
    hasRealtimeData: overrides.hasRealtimeData ?? false,
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
  for (const fn of [
    searchParkApiV2,
    searchParkApiV3,
    searchDbBahnPark,
    searchRdwNl,
    searchBnlsFr,
    searchGhentBe,
    searchBrusselsBe,
    searchBaselCh,
    searchFlorenceIt,
    searchBarcelonaEs,
    searchViennaAt,
    searchCopenhagenDk,
    searchSingapore,
    searchMadridEs,
    searchUtmcNewcastle,
    searchNswAu,
    searchNdwTruckNl,
    searchAutobahnDe,
    searchOdhIt,
    searchCitaLu,
    searchNrwMobidrom,
    searchNrwPr,
    searchApag,
    searchApcoa,
    searchGoldbeck,
    searchOsmParking,
  ]) {
    vi.mocked(fn).mockResolvedValue([]);
  }
}

// Meta

describe("parkingProvider meta", () => {
  it("has id 'parking'", () => {
    expect(parkingProvider.id).toBe("parking");
  });

  it("meta does not contain id, name, or attribution (sourced from manifest)", () => {
    expect("id" in parkingProvider.meta).toBe(false);
    expect("name" in parkingProvider.meta).toBe(false);
    expect("attribution" in parkingProvider.meta).toBe(false);
  });
});

// search()

describe("parkingProvider.search", () => {
  it("queries all sources in parallel and combines in priority order", async () => {
    setupEmptySources();
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
    const db = [makeFacility({ id: "db-bahnpark:1", sources: ["db"] })];
    const v3 = [makeFacility({ id: "parkapi-v3:2", sources: ["v3"] })];
    const osm = [makeFacility({ id: "osm:node/4", sources: ["osm"] })];

    vi.mocked(searchParkApiV3).mockResolvedValue(v3);
    vi.mocked(searchDbBahnPark).mockResolvedValue(db);
    vi.mocked(searchOsmParking).mockResolvedValue(osm);

    const results = await parkingProvider.search(makeBbox());

    // DB appears before v3, both before OSM (last source)
    const dedupCall = vi.mocked(deduplicateParking).mock.calls[0][0];
    const ids = dedupCall.map((f: ParkingFacility) => f.id);
    expect(ids.indexOf("db-bahnpark:1")).toBeLessThan(ids.indexOf("parkapi-v3:2"));
    expect(ids.indexOf("parkapi-v3:2")).toBeLessThan(ids.indexOf("osm:node/4"));
    expect(results).toHaveLength(3);
  });

  it("individual source failures handled gracefully", async () => {
    setupEmptySources();
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id));
    // Fail most sources but keep DB alive
    for (const fn of [
      searchParkApiV2,
      searchParkApiV3,
      searchRdwNl,
      searchBnlsFr,
      searchOsmParking,
    ]) {
      vi.mocked(fn).mockRejectedValue(new Error("down"));
    }
    vi.mocked(searchDbBahnPark).mockResolvedValue([makeFacility({ id: "db:1" })]);

    const results = await parkingProvider.search(makeBbox());

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("db:1");
  });

  it("all sources fail → returns empty array", async () => {
    for (const fn of [
      searchParkApiV2,
      searchParkApiV3,
      searchDbBahnPark,
      searchRdwNl,
      searchBnlsFr,
      searchGhentBe,
      searchBrusselsBe,
      searchBaselCh,
      searchFlorenceIt,
      searchBarcelonaEs,
      searchViennaAt,
      searchCopenhagenDk,
      searchSingapore,
      searchMadridEs,
      searchUtmcNewcastle,
      searchNswAu,
      searchNdwTruckNl,
      searchAutobahnDe,
      searchOdhIt,
      searchCitaLu,
      searchNrwMobidrom,
      searchNrwPr,
      searchApag,
      searchApcoa,
      searchGoldbeck,
      searchOsmParking,
    ]) {
      vi.mocked(fn).mockRejectedValue(new Error("down"));
    }
    vi.mocked(deduplicateParking).mockReturnValue([]);

    const results = await parkingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });
});

// Filters

describe("parkingProvider.search filters", () => {
  function setupSources(facilities: ParkingFacility[]) {
    setupEmptySources();
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
      sources: ["db"],
      name: "Parking",
      coordinates: [11.5, 48.5] as [number, number],
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
      sources: ["parkapi-v2"],
      name: "Lot 42",
      coordinates: [11.5, 48.5] as [number, number],
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
      sources: ["parkapi-v3"],
      name: "P",
      coordinates: [0, 0],
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
      sources: ["db"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = await parkingProvider.getDetail("db-bahnpark:ABC");
    expect(fetchDbBahnParkDetail).toHaveBeenCalledWith("ABC");
    expect(result.id).toBe("db-bahnpark:ABC");
  });

  it("cache miss with rdw: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "rdw:2459/P1_FLOW" });
    vi.mocked(fetchRdwNlDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "rdw:2459/P1_FLOW",
      sources: ["rdw-nl"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = await parkingProvider.getDetail("rdw:2459/P1_FLOW");
    expect(fetchRdwNlDetail).toHaveBeenCalledWith("2459", "P1_FLOW");
    expect(result.id).toBe("rdw:2459/P1_FLOW");
  });

  it("cache miss with bnls: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "bnls:FR-75056-P-001" });
    vi.mocked(fetchBnlsFrDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "bnls:FR-75056-P-001",
      sources: ["bnls-fr"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = await parkingProvider.getDetail("bnls:FR-75056-P-001");
    expect(fetchBnlsFrDetail).toHaveBeenCalledWith("FR-75056-P-001");
    expect(result.id).toBe("bnls:FR-75056-P-001");
  });

  it("cache miss with osm: prefix fetches element", async () => {
    const facility = makeFacility({ id: "osm:way/999" });
    vi.mocked(fetchOsmParkingElement).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "osm:way/999",
      sources: ["osm"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = await parkingProvider.getDetail("osm:way/999");
    expect(fetchOsmParkingElement).toHaveBeenCalledWith("way", 999);
    expect(result.id).toBe("osm:way/999");
  });

  it("cache miss with cita-lu: prefix fetches DATEX detail", async () => {
    const facility = makeFacility({ id: "cita-lu:P1", sources: ["cita-lu"] });
    vi.mocked(fetchCitaLuDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "cita-lu:P1",
      sources: ["cita-lu"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = await parkingProvider.getDetail("cita-lu:P1");
    expect(fetchCitaLuDetail).toHaveBeenCalledWith("P1");
    expect(result.id).toBe("cita-lu:P1");
  });

  it("unknown prefix returns fallback detail", async () => {
    const result = await parkingProvider.getDetail("xyz:totally-unknown-parking");
    expect(result.id).toBe("xyz:totally-unknown-parking");
    expect(result.sources).toEqual(["unknown"]);
    expect(result.name).toBe("Parking");
    expect(result.coordinates).toEqual([0, 0]);
    expect(result.sections).toEqual([]);
  });
});
