import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockDeTankerkoenigKey: string | undefined;

vi.mock("../factory.js", () => ({
  searchFuelStations: vi.fn(),
  getDeTankerkoenigApiKey: () => mockDeTankerkoenigKey,
  setDeTankerkoenigApiKey: (value: string | undefined) => {
    mockDeTankerkoenigKey = value && value.length > 0 ? value : undefined;
  },
}));

vi.mock("../mapper.js", () => ({
  mapFuelStationToResult: vi.fn(),
  mapFuelStationToDetail: vi.fn(),
  buildDeTankerkoenigDetail: vi.fn(),
}));

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    CATEGORY_FILTERS: { fuel: [{ key: "amenity", value: "fuel" }] },
    searchByCategory: vi.fn(),
  };
});

import { searchByCategory } from "@openmapx/core";
import { searchFuelStations } from "../factory.js";
import {
  buildDeTankerkoenigDetail,
  mapFuelStationToDetail,
  mapFuelStationToResult,
} from "../mapper.js";
import { fuelProvider, setManifestDataSources } from "../provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

// Mirror the manifest dataSources the host loads at runtime so the provider's
// attribution lookup has something to map `source` prefixes against.
beforeEach(() => {
  setManifestDataSources([
    {
      sourceId: "de-tankerkoenig",
      name: "Tankerkoenig (MTS-K)",
      url: "https://creativecommons.tankerkoenig.de/",
      license: "CC BY 4.0",
      providerCountry: "DE",
      providerPrivacyUrl: "https://onboarding.tankerkoenig.de/datenschutz",
    },
    {
      sourceId: "osm",
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org/",
      license: "ODbL 1.0",
      providerCountry: "UK",
      providerPrivacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockDeTankerkoenigKey = undefined;
});

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeStation(id: string, prices: FuelStation["fuelPrices"] = {}): FuelStation {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    fuelPrices: prices,
  };
}

function makeResult(id: string): DataSourceResult {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    source: "de-tankerkoenig",
    variant: "unknown",
    status: "unknown",
  };
}

// search()

describe("fuelProvider.search", () => {
  it("stations found: caches and maps results", async () => {
    const stations = [makeStation("s1"), makeStation("s2")];
    vi.mocked(searchFuelStations).mockResolvedValue(stations);
    vi.mocked(mapFuelStationToResult).mockImplementation((s: FuelStation) => makeResult(s.id));

    const envelope = await fuelProvider.search(makeBbox());
    const results = envelope.data;

    expect(searchFuelStations).toHaveBeenCalledWith(makeBbox());
    expect(mapFuelStationToResult).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("s1");
    expect(envelope.attributions.length).toBeGreaterThan(0);
    expect(envelope.attributions[0].sourceId).toBe("de-tankerkoenig");
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("null result falls back to Overpass", async () => {
    vi.mocked(searchFuelStations).mockResolvedValue(null as never);
    vi.mocked(searchByCategory).mockResolvedValue({
      results: [{ id: "osm:node/100", name: "Shell", coordinates: [11.5, 48.5] }],
      truncated: false,
    } as never);

    const results = (await fuelProvider.search(makeBbox())).data;

    expect(searchByCategory).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("osm");
  });

  it("fuelType filter: filters by price data presence in station cache", async () => {
    const stations = [
      makeStation("fa", { diesel: 1.5 }),
      makeStation("fb", { e5: 1.7 }),
      makeStation("fc", { diesel: 1.48, e10: 1.6 }),
    ];
    vi.mocked(searchFuelStations).mockResolvedValue(stations);
    vi.mocked(mapFuelStationToResult).mockImplementation((s: FuelStation) => makeResult(s.id));

    const results = (await fuelProvider.search(makeBbox(), { fuelType: "diesel" })).data;

    expect(results.map((r) => r.id)).toEqual(["fa", "fc"]);
  });

  it("fuelType filter with array: matches any listed type", async () => {
    const stations = [
      makeStation("fx", { diesel: 1.5 }),
      makeStation("fy", { e5: 1.7 }),
      makeStation("fz", { lpg: 0.8 }),
    ];
    vi.mocked(searchFuelStations).mockResolvedValue(stations);
    vi.mocked(mapFuelStationToResult).mockImplementation((s: FuelStation) => makeResult(s.id));

    const results = (await fuelProvider.search(makeBbox(), { fuelType: ["e5", "lpg"] })).data;

    expect(results.map((r) => r.id)).toEqual(["fy", "fz"]);
  });

  it("gap-fills a Commons logo on the Overpass fallback from a brand:wikidata tag", async () => {
    vi.mocked(searchFuelStations).mockResolvedValue(null as never);
    vi.mocked(searchByCategory).mockResolvedValue({
      results: [
        {
          id: "osm:node/300",
          name: "Shell",
          coordinates: [11.5, 48.5],
          // Q110716465 — verified against packages/brands/src/data/brands-index.json.
          osmTags: { "brand:wikidata": "Q110716465" },
        },
      ],
      truncated: false,
    } as never);

    const results = (await fuelProvider.search(makeBbox())).data;

    expect(results[0].branding?.name).toBe("Shell");
    expect(results[0].branding?.logoUrl).toContain("commons.wikimedia.org");
  });

  it("leaves branding unfilled on the Overpass fallback when there is no catalogued identity", async () => {
    vi.mocked(searchFuelStations).mockResolvedValue(null as never);
    vi.mocked(searchByCategory).mockResolvedValue({
      results: [{ id: "osm:node/301", name: "Unbranded Fuel", coordinates: [11.5, 48.5] }],
      truncated: false,
    } as never);

    const results = (await fuelProvider.search(makeBbox())).data;

    expect(results[0].branding).toBeUndefined();
  });

  it("OSM-only results kept when fuelType filter active (no cache entry)", async () => {
    vi.mocked(searchFuelStations).mockResolvedValue(null as never);
    vi.mocked(searchByCategory).mockResolvedValue({
      results: [{ id: "osm:node/200", name: "OSM Station", coordinates: [11.5, 48.5] }],
      truncated: false,
    } as never);

    const results = (await fuelProvider.search(makeBbox(), { fuelType: "diesel" })).data;

    // OSM results have no cache entry, so they should be kept (return true)
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("osm:node/200");
  });
});

// getDetail()

describe("fuelProvider.getDetail", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("de-tankerkoenig/ prefix with valid UUID and API key fetches enriched detail", async () => {
    mockDeTankerkoenigKey = "test-key-123";

    const uuid = "51d4b477-a095-1aa0-e100-80009459e03a";
    const itemId = `de-tankerkoenig/${uuid}`;

    const apiStation = {
      id: uuid,
      name: "Aral",
      brand: "Aral",
      openingTimes: [],
      overrides: [],
      wholeDay: true,
      isOpen: true,
      e5: 1.699,
      e10: 1.639,
      diesel: 1.559,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, station: apiStation }),
    });

    const enrichedDetail = {
      id: itemId,
      source: "de-tankerkoenig",
      name: "Aral",
      coordinates: [0, 0] as [number, number],
      sections: [],
    };
    vi.mocked(buildDeTankerkoenigDetail).mockReturnValue(enrichedDetail);

    const envelope = await fuelProvider.getDetail(itemId);

    expect(mockFetch).toHaveBeenCalledOnce();
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("detail.php");
    expect(fetchUrl).toContain(uuid);
    expect(buildDeTankerkoenigDetail).toHaveBeenCalled();
    expect(envelope.data).toBe(enrichedDetail);
    expect(envelope.attributions.length).toBeGreaterThan(0);
    expect(envelope.attributions[0].sourceId).toBe("de-tankerkoenig");
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("de-tankerkoenig/ with invalid UUID skips API call and returns null", async () => {
    mockDeTankerkoenigKey = "test-key-123";

    const itemId = "de-tankerkoenig/not-a-uuid";

    const result = (await fuelProvider.getDetail(itemId)).data;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("de-tankerkoenig/ without API key skips API call and returns null", async () => {
    mockDeTankerkoenigKey = undefined;

    const uuid = "51d4b477-a095-1aa0-e100-80009459e03a";
    const result = (await fuelProvider.getDetail(`de-tankerkoenig/${uuid}`)).data;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("cached station returned via mapFuelStationToDetail", async () => {
    // Populate cache by searching first
    const station = makeStation("fuel-cached-id", { diesel: 1.5 });
    vi.mocked(searchFuelStations).mockResolvedValue([station]);
    vi.mocked(mapFuelStationToResult).mockReturnValue(makeResult("fuel-cached-id"));
    await fuelProvider.search(makeBbox());

    const detail = {
      id: "fuel-cached-id",
      source: "de-tankerkoenig",
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapFuelStationToDetail).mockReturnValue(detail);

    const result = (await fuelProvider.getDetail("fuel-cached-id")).data;
    expect(mapFuelStationToDetail).toHaveBeenCalledWith(station);
    expect(result).toBe(detail);
  });

  it("returns null for unknown item with no cache entry", async () => {
    const result = (await fuelProvider.getDetail("totally-unknown-fuel-999")).data;
    expect(result).toBeNull();
  });

  it("de-tankerkoenig/ API fetch failure falls through to null when no cache entry", async () => {
    mockDeTankerkoenigKey = "test-key";

    const uuid = "51d4b477-a095-1aa0-e100-80009459e03a";
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = (await fuelProvider.getDetail(`de-tankerkoenig/${uuid}`)).data;
    expect(result).toBeNull();
  });
});
