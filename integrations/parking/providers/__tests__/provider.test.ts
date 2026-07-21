import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../de-apag.js", () => ({ searchDeApag: vi.fn(), fetchDeApagDetail: vi.fn() }));
vi.mock("../de-apcoa.js", () => ({ searchDeApcoa: vi.fn(), fetchDeApcoaDetail: vi.fn() }));
vi.mock("../de-autobahn.js", () => ({
  searchDeAutobahn: vi.fn(),
  fetchDeAutobahnDetail: vi.fn(),
}));
vi.mock("../es-ct-barcelona.js", () => ({
  searchEsCtBarcelona: vi.fn(),
  fetchEsCtBarcelonaDetail: vi.fn(),
}));
vi.mock("../ch-bs-basel.js", () => ({ searchChBsBasel: vi.fn(), fetchChBsBaselDetail: vi.fn() }));
vi.mock("../fr-bnls.js", () => ({ searchFrBnls: vi.fn(), fetchFrBnlsDetail: vi.fn() }));
vi.mock("../be-bru-brussels.js", () => ({
  searchBeBruBrussels: vi.fn(),
  fetchBeBruBrusselsDetail: vi.fn(),
}));
vi.mock("../lu-cita.js", () => ({ searchLuCita: vi.fn(), fetchLuCitaDetail: vi.fn() }));
vi.mock("../dk-84-copenhagen.js", () => ({
  searchDk84Copenhagen: vi.fn(),
  fetchDk84CopenhagenDetail: vi.fn(),
}));
vi.mock("../de-db-bahnpark.js", () => ({
  searchDeDbBahnPark: vi.fn(),
  fetchDeDbBahnParkDetail: vi.fn(),
}));
vi.mock("../dedup.js", () => ({ deduplicateParking: vi.fn((items: unknown[]) => items) }));
vi.mock("../it-52-florence.js", () => ({
  searchIt52Florence: vi.fn(),
  fetchIt52FlorenceDetail: vi.fn(),
}));
vi.mock("../be-vlg-ghent.js", () => ({
  searchBeVlgGhent: vi.fn(),
  fetchBeVlgGhentDetail: vi.fn(),
}));
vi.mock("../de-goldbeck.js", () => ({ searchDeGoldbeck: vi.fn(), fetchDeGoldbeckDetail: vi.fn() }));
vi.mock("../es-md-madrid.js", () => ({
  searchEsMdMadrid: vi.fn(),
  fetchEsMdMadridDetail: vi.fn(),
}));
vi.mock("../nl-ndw-truck.js", () => ({
  searchNlNdwTruck: vi.fn(),
  fetchNlNdwTruckDetail: vi.fn(),
}));
vi.mock("../de-nw-mobidrom.js", () => ({
  searchDeNwMobidrom: vi.fn(),
  fetchDeNwMobidromDetail: vi.fn(),
}));
vi.mock("../de-nw-mobidrom-pr.js", () => ({
  searchDeNwMobidromPr: vi.fn(),
  fetchDeNwMobidromPrDetail: vi.fn(),
}));
vi.mock("../it-32-opendatahub.js", () => ({
  searchIt32Opendatahub: vi.fn(),
  fetchIt32OpendatahubDetail: vi.fn(),
}));
vi.mock("../mapper.js", () => ({ mapParkingToResult: vi.fn(), mapParkingToDetail: vi.fn() }));
vi.mock("../au-nsw.js", () => ({ searchAuNsw: vi.fn(), fetchAuNswDetail: vi.fn() }));
vi.mock("../osm.js", () => ({ searchOsmParking: vi.fn(), fetchOsmParkingElement: vi.fn() }));
vi.mock("../de-parkapi-v2.js", () => ({
  searchDeParkapiV2: vi.fn(),
  fetchDeParkapiV2Detail: vi.fn(),
}));
vi.mock("../de-parkapi-v3.js", () => ({
  searchDeParkapiV3: vi.fn(),
  fetchDeParkapiV3Detail: vi.fn(),
}));
vi.mock("../nl-rdw.js", () => ({ searchNlRdw: vi.fn(), fetchNlRdwDetail: vi.fn() }));
vi.mock("../sg-hdb.js", () => ({ searchSgHdb: vi.fn(), fetchSgHdbDetail: vi.fn() }));
vi.mock("../gb-eng-utmc.js", () => ({
  searchGbEngUtmc: vi.fn(),
  fetchGbEngUtmcDetail: vi.fn(),
}));
vi.mock("../at-9-vienna.js", () => ({ searchAt9Vienna: vi.fn(), fetchAt9ViennaDetail: vi.fn() }));

import { searchAt9Vienna } from "../at-9-vienna.js";
import { searchAuNsw } from "../au-nsw.js";
import { searchBeBruBrussels } from "../be-bru-brussels.js";
import { searchBeVlgGhent } from "../be-vlg-ghent.js";
import { searchChBsBasel } from "../ch-bs-basel.js";
import { searchDeApag } from "../de-apag.js";
import { searchDeApcoa } from "../de-apcoa.js";
import { searchDeAutobahn } from "../de-autobahn.js";
import { fetchDeDbBahnParkDetail, searchDeDbBahnPark } from "../de-db-bahnpark.js";
import { searchDeGoldbeck } from "../de-goldbeck.js";
import { searchDeNwMobidrom } from "../de-nw-mobidrom.js";
import { searchDeNwMobidromPr } from "../de-nw-mobidrom-pr.js";
import { fetchDeParkapiV2Detail, searchDeParkapiV2 } from "../de-parkapi-v2.js";
import { fetchDeParkapiV3Detail, searchDeParkapiV3 } from "../de-parkapi-v3.js";
import { deduplicateParking } from "../dedup.js";
import { searchDk84Copenhagen } from "../dk-84-copenhagen.js";
import { searchEsCtBarcelona } from "../es-ct-barcelona.js";
import { searchEsMdMadrid } from "../es-md-madrid.js";
import { fetchFrBnlsDetail, searchFrBnls } from "../fr-bnls.js";
import { searchGbEngUtmc } from "../gb-eng-utmc.js";
import { searchIt32Opendatahub } from "../it-32-opendatahub.js";
import { searchIt52Florence } from "../it-52-florence.js";
import { fetchLuCitaDetail, searchLuCita } from "../lu-cita.js";
import { mapParkingToDetail, mapParkingToResult } from "../mapper.js";
import { searchNlNdwTruck } from "../nl-ndw-truck.js";
import { fetchNlRdwDetail, searchNlRdw } from "../nl-rdw.js";
import { fetchOsmParkingElement, searchOsmParking } from "../osm.js";
import { parkingProvider, setManifestDataSources } from "../provider.js";
import { searchSgHdb } from "../sg-hdb.js";

// Mirror the manifest dataSources the host loads at runtime so the provider's
// attribution lookup has something to map `source` prefixes against.
beforeEach(() => {
  setManifestDataSources([
    {
      sourceId: "de-parkapi-v2",
      name: "ParkenDD",
      url: "https://github.com/ParkenDD/park-api-v2",
      license: "test",
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "de-parkapi-v3",
      name: "ParkenDD v3",
      url: "https://github.com/ParkenDD/park-api-v3",
      license: "test",
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "de-db-bahnpark",
      name: "DB BahnPark",
      url: "https://example.com/db",
      license: "test",
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "osm",
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org/",
      license: "ODbL 1.0",
      providerCountry: "UK",
      providerPrivacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
    },
    {
      sourceId: "test",
      name: "Test Source",
      url: "https://example.com/test",
      license: "test",
      providerCountry: "XX",
      providerPrivacyUrl: "https://example.com/privacy",
    },
  ]);
});

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

function makeResult(id: string, sources: string[] = ["test"]): DataSourceResult {
  return {
    id,
    name: `Parking ${id}`,
    coordinates: [11.5, 48.5],
    source: sources[0],
    sources,
    variant: "unknown",
    status: "unknown",
  };
}

function setupEmptySources() {
  for (const fn of [
    searchDeParkapiV2,
    searchDeParkapiV3,
    searchDeDbBahnPark,
    searchNlRdw,
    searchFrBnls,
    searchBeVlgGhent,
    searchBeBruBrussels,
    searchChBsBasel,
    searchIt52Florence,
    searchEsCtBarcelona,
    searchAt9Vienna,
    searchDk84Copenhagen,
    searchSgHdb,
    searchEsMdMadrid,
    searchGbEngUtmc,
    searchAuNsw,
    searchNlNdwTruck,
    searchDeAutobahn,
    searchIt32Opendatahub,
    searchLuCita,
    searchDeNwMobidrom,
    searchDeNwMobidromPr,
    searchDeApag,
    searchDeApcoa,
    searchDeGoldbeck,
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
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id, f.sources));
    const db = [makeFacility({ id: "db-bahnpark:1", sources: ["de-db-bahnpark"] })];
    const v3 = [makeFacility({ id: "parkapi-v3:2", sources: ["de-parkapi-v3"] })];
    const osm = [makeFacility({ id: "osm:node/4", sources: ["osm"] })];

    vi.mocked(searchDeParkapiV3).mockResolvedValue(v3);
    vi.mocked(searchDeDbBahnPark).mockResolvedValue(db);
    vi.mocked(searchOsmParking).mockResolvedValue(osm);

    const envelope = await parkingProvider.search(makeBbox());
    const results = envelope.data;

    // DB appears before v3, both before OSM (last source)
    const dedupCall = vi.mocked(deduplicateParking).mock.calls[0][0];
    const ids = dedupCall.map((f: ParkingFacility) => f.id);
    expect(ids.indexOf("db-bahnpark:1")).toBeLessThan(ids.indexOf("parkapi-v3:2"));
    expect(ids.indexOf("parkapi-v3:2")).toBeLessThan(ids.indexOf("osm:node/4"));
    expect(results).toHaveLength(3);
    // Attribution credits only the sources that actually contributed, in the
    // order they appear in the merged result list.
    expect(envelope.attributions.map((a) => a.sourceId)).toEqual([
      "de-db-bahnpark",
      "de-parkapi-v3",
      "osm",
    ]);
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("individual source failures handled gracefully", async () => {
    setupEmptySources();
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id, f.sources));
    // Fail most sources but keep DB alive
    for (const fn of [
      searchDeParkapiV2,
      searchDeParkapiV3,
      searchNlRdw,
      searchFrBnls,
      searchOsmParking,
    ]) {
      vi.mocked(fn).mockRejectedValue(new Error("down"));
    }
    vi.mocked(searchDeDbBahnPark).mockResolvedValue([makeFacility({ id: "db:1" })]);

    const results = (await parkingProvider.search(makeBbox())).data;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("db:1");
  });

  it("all sources fail → returns empty array", async () => {
    for (const fn of [
      searchDeParkapiV2,
      searchDeParkapiV3,
      searchDeDbBahnPark,
      searchNlRdw,
      searchFrBnls,
      searchBeVlgGhent,
      searchBeBruBrussels,
      searchChBsBasel,
      searchIt52Florence,
      searchEsCtBarcelona,
      searchAt9Vienna,
      searchDk84Copenhagen,
      searchSgHdb,
      searchEsMdMadrid,
      searchGbEngUtmc,
      searchAuNsw,
      searchNlNdwTruck,
      searchDeAutobahn,
      searchIt32Opendatahub,
      searchLuCita,
      searchDeNwMobidrom,
      searchDeNwMobidromPr,
      searchDeApag,
      searchDeApcoa,
      searchDeGoldbeck,
      searchOsmParking,
    ]) {
      vi.mocked(fn).mockRejectedValue(new Error("down"));
    }
    vi.mocked(deduplicateParking).mockReturnValue([]);

    const results = (await parkingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });
});

// Filters

describe("parkingProvider.search filters", () => {
  function setupSources(facilities: ParkingFacility[]) {
    setupEmptySources();
    vi.mocked(searchOsmParking).mockResolvedValue(facilities);
    vi.mocked(deduplicateParking).mockReturnValue(facilities);
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id, f.sources));
  }

  it("parkingType filter: only matching types returned", async () => {
    const facilities = [
      makeFacility({ id: "pt-a", parkingType: "garage" }),
      makeFacility({ id: "pt-b", parkingType: "surface" }),
      makeFacility({ id: "pt-c", parkingType: "underground" }),
    ];
    setupSources(facilities);

    const results = (
      await parkingProvider.search(makeBbox(), {
        parkingType: ["garage", "underground"],
      })
    ).data;

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

    const results = (await parkingProvider.search(makeBbox(), { fee: "free" })).data;

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

    const results = (await parkingProvider.search(makeBbox(), { availability: "available" })).data;

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["av-a", "av-c"]);
  });

  it("availability 'available' + 'full' includes all", async () => {
    const facilities = [
      makeFacility({ id: "af-a", hasRealtimeData: true, freeSpaces: 10 }),
      makeFacility({ id: "af-b", hasRealtimeData: true, freeSpaces: 0 }),
    ];
    setupSources(facilities);

    const results = (
      await parkingProvider.search(makeBbox(), {
        availability: ["available", "full"],
      })
    ).data;

    expect(results).toHaveLength(2);
  });

  it("features 'disabled' filters to facilities with disabledSpaces > 0", async () => {
    const facilities = [
      makeFacility({ id: "fd-a", disabledSpaces: 5 }),
      makeFacility({ id: "fd-b", disabledSpaces: 0 }),
      makeFacility({ id: "fd-c" }),
    ];
    setupSources(facilities);

    const results = (await parkingProvider.search(makeBbox(), { features: "disabled" })).data;

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

    const results = (await parkingProvider.search(makeBbox(), { features: "ev-charging" })).data;

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

    const results = (await parkingProvider.search(makeBbox(), { features: "park-and-ride" })).data;

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

    const results = (
      await parkingProvider.search(makeBbox(), {
        features: ["disabled", "ev-charging"],
      })
    ).data;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("fm-a");
  });
});

// getDetail()

describe("parkingProvider.getDetail", () => {
  it("cache hit returns mapped detail", async () => {
    vi.mocked(mapParkingToResult).mockImplementation((f) => makeResult(f.id, f.sources));
    const facility = makeFacility({ id: "pk-cached-1" });
    vi.mocked(searchDeParkapiV2).mockResolvedValue([]);
    vi.mocked(searchDeParkapiV3).mockResolvedValue([]);
    vi.mocked(searchDeDbBahnPark).mockResolvedValue([facility]);
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

    const envelope = await parkingProvider.getDetail("pk-cached-1");
    expect(mapParkingToDetail).toHaveBeenCalledWith(facility);
    expect(envelope.data).toBe(detail);
    // Credits the source the cached facility was loaded from.
    expect(envelope.attributions.map((a) => a.sourceId)).toEqual(["test"]);
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("cache miss with de-parkapi-v2: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "de-parkapi-v2:berlin/lot42" });
    vi.mocked(fetchDeParkapiV2Detail).mockResolvedValue(facility);

    // Mock enrichFacility's internal calls
    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);

    const detail = {
      id: "de-parkapi-v2:berlin/lot42",
      sources: ["de-parkapi-v2"],
      name: "Lot 42",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapParkingToDetail).mockReturnValue(detail);

    const result = (await parkingProvider.getDetail("de-parkapi-v2:berlin/lot42")).data;
    expect(fetchDeParkapiV2Detail).toHaveBeenCalledWith("berlin", "lot42");
    expect(result).toBe(detail);
  });

  it("cache miss with de-parkapi-v3: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "de-parkapi-v3:123" });
    vi.mocked(fetchDeParkapiV3Detail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "de-parkapi-v3:123",
      sources: ["de-parkapi-v3"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = (await parkingProvider.getDetail("de-parkapi-v3:123")).data;
    expect(fetchDeParkapiV3Detail).toHaveBeenCalledWith(123);
    expect(result?.id).toBe("de-parkapi-v3:123");
  });

  it("cache miss with de-db-bahnpark: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "de-db-bahnpark:ABC" });
    vi.mocked(fetchDeDbBahnParkDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "de-db-bahnpark:ABC",
      sources: ["db"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = (await parkingProvider.getDetail("de-db-bahnpark:ABC")).data;
    expect(fetchDeDbBahnParkDetail).toHaveBeenCalledWith("ABC");
    expect(result?.id).toBe("de-db-bahnpark:ABC");
  });

  it("cache miss with nl-rdw: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "nl-rdw:2459/P1_FLOW" });
    vi.mocked(fetchNlRdwDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "nl-rdw:2459/P1_FLOW",
      sources: ["nl-rdw"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = (await parkingProvider.getDetail("nl-rdw:2459/P1_FLOW")).data;
    expect(fetchNlRdwDetail).toHaveBeenCalledWith("2459", "P1_FLOW");
    expect(result?.id).toBe("nl-rdw:2459/P1_FLOW");
  });

  it("cache miss with fr-bnls: prefix fetches detail", async () => {
    const facility = makeFacility({ id: "fr-bnls:FR-75056-P-001" });
    vi.mocked(fetchFrBnlsDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "fr-bnls:FR-75056-P-001",
      sources: ["fr-bnls"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = (await parkingProvider.getDetail("fr-bnls:FR-75056-P-001")).data;
    expect(fetchFrBnlsDetail).toHaveBeenCalledWith("FR-75056-P-001");
    expect(result?.id).toBe("fr-bnls:FR-75056-P-001");
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

    const result = (await parkingProvider.getDetail("osm:way/999")).data;
    expect(fetchOsmParkingElement).toHaveBeenCalledWith("way", 999);
    expect(result?.id).toBe("osm:way/999");
  });

  it("cache miss with lu-cita: prefix fetches DATEX detail", async () => {
    const facility = makeFacility({ id: "lu-cita:P1", sources: ["lu-cita"] });
    vi.mocked(fetchLuCitaDetail).mockResolvedValue(facility);

    setupEmptySources();
    vi.mocked(deduplicateParking).mockReturnValue([facility]);
    vi.mocked(mapParkingToDetail).mockReturnValue({
      id: "lu-cita:P1",
      sources: ["lu-cita"],
      name: "P",
      coordinates: [0, 0],
      sections: [],
    });

    const result = (await parkingProvider.getDetail("lu-cita:P1")).data;
    expect(fetchLuCitaDetail).toHaveBeenCalledWith("P1");
    expect(result?.id).toBe("lu-cita:P1");
  });

  it("unknown prefix returns fallback detail", async () => {
    const result = (await parkingProvider.getDetail("xyz:totally-unknown-parking")).data;
    expect(result?.id).toBe("xyz:totally-unknown-parking");
    expect(result?.sources).toEqual(["unknown"]);
    expect(result?.name).toBe("Parking");
    expect(result?.coordinates).toEqual([0, 0]);
    expect(result?.sections).toEqual([]);
  });
});
