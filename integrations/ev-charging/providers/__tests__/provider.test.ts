import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ocm.js", () => ({
  searchOcm: vi.fn(),
  getOcmDetail: vi.fn(),
}));

vi.mock("../osm.js", () => ({
  searchOsmCharging: vi.fn(),
  getOsmChargingNode: vi.fn(),
}));

vi.mock("../ocm-mapper.js", () => ({
  mapOcmToResult: vi.fn(),
  mapOcmToDetail: vi.fn(),
}));

vi.mock("../osm-mapper.js", () => ({
  mapOsmToResult: vi.fn(),
  mapOsmToDetail: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  deduplicateByCoordinates: vi.fn((items: unknown[]) => items),
}));

vi.mock("../reference.js", () => ({
  getEvChargingFilters: vi.fn(),
}));

import { deduplicateByCoordinates } from "../dedup.js";
import { getOcmDetail, searchOcm } from "../ocm.js";
import { mapOcmToDetail, mapOcmToResult } from "../ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "../osm.js";
import { mapOsmToDetail, mapOsmToResult } from "../osm-mapper.js";
import { evChargingProvider } from "../provider.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeResult(id: string, variant: string): DataSourceResult {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    source: "ocm",
    variant,
    status: "available",
  };
}

// Meta

describe("evChargingProvider meta", () => {
  it("has id 'ev-charging'", () => {
    expect(evChargingProvider.id).toBe("ev-charging");
  });

  it("meta does not contain id, name, or attribution (sourced from manifest)", () => {
    expect("id" in evChargingProvider.meta).toBe(false);
    expect("name" in evChargingProvider.meta).toBe(false);
    expect("attribution" in evChargingProvider.meta).toBe(false);
  });
});

// search()

describe("evChargingProvider.search", () => {
  it("calls OCM and OSM in parallel and combines results", async () => {
    const ocmRaw = [{ id: 1 }];
    const osmRaw = [{ id: 2 }];
    vi.mocked(searchOcm).mockResolvedValue(ocmRaw as never);
    vi.mocked(searchOsmCharging).mockResolvedValue(osmRaw as never);

    const ocmMapped = makeResult("ocm:1", "fast");
    const osmMapped = makeResult("osm:2", "slow");
    vi.mocked(mapOcmToResult).mockReturnValue(ocmMapped);
    vi.mocked(mapOsmToResult).mockReturnValue(osmMapped);
    vi.mocked(deduplicateByCoordinates).mockReturnValue([ocmMapped, osmMapped]);

    const results = await evChargingProvider.search(makeBbox());

    expect(searchOcm).toHaveBeenCalledOnce();
    expect(searchOsmCharging).toHaveBeenCalledOnce();
    expect(deduplicateByCoordinates).toHaveBeenCalledWith([ocmMapped, osmMapped]);
    expect(results).toEqual([ocmMapped, osmMapped]);
  });

  it("OCM mapped first for dedup priority", async () => {
    vi.mocked(searchOcm).mockResolvedValue([{ id: 10 }] as never);
    vi.mocked(searchOsmCharging).mockResolvedValue([{ id: 20 }] as never);
    vi.mocked(mapOcmToResult).mockReturnValue(makeResult("ocm:10", "fast"));
    vi.mocked(mapOsmToResult).mockReturnValue(makeResult("osm:20", "slow"));

    await evChargingProvider.search(makeBbox());

    const call = vi.mocked(deduplicateByCoordinates).mock.calls[0][0];
    expect(call[0].id).toBe("ocm:10");
    expect(call[1].id).toBe("osm:20");
  });

  it("OCM fails gracefully, OSM results still returned", async () => {
    vi.mocked(searchOcm).mockRejectedValue(new Error("OCM down"));
    vi.mocked(searchOsmCharging).mockResolvedValue([{ id: 3 }] as never);

    const osmMapped = makeResult("osm:3", "slow");
    vi.mocked(mapOsmToResult).mockReturnValue(osmMapped);
    vi.mocked(deduplicateByCoordinates).mockReturnValue([osmMapped]);

    const results = await evChargingProvider.search(makeBbox());
    expect(results).toEqual([osmMapped]);
    expect(mapOcmToResult).not.toHaveBeenCalled();
  });

  it("OSM fails gracefully, OCM results still returned", async () => {
    vi.mocked(searchOcm).mockResolvedValue([{ id: 4 }] as never);
    vi.mocked(searchOsmCharging).mockRejectedValue(new Error("OSM down"));

    const ocmMapped = makeResult("ocm:4", "ultra-rapid");
    vi.mocked(mapOcmToResult).mockReturnValue(ocmMapped);
    vi.mocked(deduplicateByCoordinates).mockReturnValue([ocmMapped]);

    const results = await evChargingProvider.search(makeBbox());
    expect(results).toEqual([ocmMapped]);
    expect(mapOsmToResult).not.toHaveBeenCalled();
  });

  it("both fail → returns empty array", async () => {
    vi.mocked(searchOcm).mockRejectedValue(new Error("OCM down"));
    vi.mocked(searchOsmCharging).mockRejectedValue(new Error("OSM down"));
    vi.mocked(deduplicateByCoordinates).mockReturnValue([]);

    const results = await evChargingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });
});

// Speed filter (client-side only — provider does not filter by speed)

describe("evChargingProvider.search speed filter", () => {
  it("ignores speed filter (applied client-side)", async () => {
    vi.mocked(searchOcm).mockResolvedValue([]);
    vi.mocked(searchOsmCharging).mockResolvedValue([]);
    const items = [
      makeResult("a", "slow"),
      makeResult("b", "fast"),
      makeResult("c", "ultra-rapid"),
    ];
    vi.mocked(deduplicateByCoordinates).mockReturnValue(items);

    const results = await evChargingProvider.search(makeBbox(), { speed: "fast" });
    expect(results).toHaveLength(3);
  });
});

// getDetail()

describe("evChargingProvider.getDetail", () => {
  it("'ocm:' prefix calls getOcmDetail and maps result", async () => {
    const poi = { id: 42 };
    vi.mocked(getOcmDetail).mockResolvedValue(poi as never);
    const mapped = {
      id: "ocm:42",
      source: "ocm",
      name: "Station",
      coordinates: [11, 48] as [number, number],
      sections: [],
    };
    vi.mocked(mapOcmToDetail).mockReturnValue(mapped);

    const result = await evChargingProvider.getDetail("ocm:42");
    expect(getOcmDetail).toHaveBeenCalledWith("42");
    expect(mapOcmToDetail).toHaveBeenCalledWith(poi);
    expect(result).toBe(mapped);
  });

  it("'osm:' prefix calls getOsmChargingNode with numeric ID", async () => {
    const node = { id: 12345, tags: {} };
    vi.mocked(getOsmChargingNode).mockResolvedValue(node as never);
    const mapped = {
      id: "osm:12345",
      source: "osm",
      name: "Charger",
      coordinates: [11, 48] as [number, number],
      sections: [],
    };
    vi.mocked(mapOsmToDetail).mockReturnValue(mapped);

    const result = await evChargingProvider.getDetail("osm:12345");
    expect(getOsmChargingNode).toHaveBeenCalledWith(12345);
    expect(mapOsmToDetail).toHaveBeenCalledWith(node);
    expect(result).toBe(mapped);
  });

  it("'ocm:' prefix returns null when getOcmDetail returns null", async () => {
    vi.mocked(getOcmDetail).mockResolvedValue(null as never);

    const result = await evChargingProvider.getDetail("ocm:999");
    expect(result).toBeNull();
  });

  it("'osm:' prefix returns null when getOsmChargingNode returns null", async () => {
    vi.mocked(getOsmChargingNode).mockResolvedValue(null as never);

    const result = await evChargingProvider.getDetail("osm:888");
    expect(result).toBeNull();
  });

  it("unknown prefix returns null", async () => {
    const result = await evChargingProvider.getDetail("xyz:100");
    expect(result).toBeNull();
  });
});
