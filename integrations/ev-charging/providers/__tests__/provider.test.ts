import type { BoundingBox, DataSourceDetail } from "@openmapx/core";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sourceA = {
    id: "source-a",
    priority: 0,
    search: vi.fn(),
    canFetchDetail: vi.fn(),
    fetchDetail: vi.fn(),
  };
  const sourceB = {
    id: "source-b",
    priority: 1,
    search: vi.fn(),
    canFetchDetail: vi.fn(),
    fetchDetail: vi.fn(),
  };
  return { sourceA, sourceB };
});

vi.mock("../registry.js", () => ({
  EV_CHARGING_SOURCE_REGISTRY: [mocks.sourceA, mocks.sourceB],
}));

vi.mock("../dedup.js", () => ({
  deduplicateChargingStations: vi.fn((items: unknown[]) => items),
  haversineMeters: vi.fn(() => 0),
}));

vi.mock("../station-mapper.js", () => ({
  mapStationToResult: vi.fn((station: EvChargingStation) => ({
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: station.sources[0],
    sources: station.sources,
    variant: "unknown",
  })),
  mapStationToDetail: vi.fn((station: EvChargingStation) => ({
    id: station.id,
    sources: station.sources,
    name: station.name,
    coordinates: station.coordinates,
    sections: [],
  })),
}));

vi.mock("../reference.js", () => ({
  getEvChargingFilters: vi.fn(),
}));

import { deduplicateChargingStations } from "../dedup.js";
import { evChargingProvider } from "../provider.js";
import { mapStationToDetail, mapStationToResult } from "../station-mapper.js";

afterEach(() => {
  vi.clearAllMocks();
});

function makeBbox(): BoundingBox {
  return { south: 48, west: 11, north: 49, east: 12 };
}

function makeStation(id: string, sources = ["source-a"]): EvChargingStation {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    sources,
    sourceItemIds: [id],
    connectors: [],
  };
}

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

describe("evChargingProvider.search", () => {
  it("searches registered sources, merges stations, and maps results", async () => {
    const a = makeStation("a", ["source-a"]);
    const b = makeStation("b", ["source-b"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([b]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([a, b]);

    const results = await evChargingProvider.search(makeBbox(), { speed: "fast" });

    expect(mocks.sourceA.search).toHaveBeenCalledWith(makeBbox(), { speed: "fast" });
    expect(mocks.sourceB.search).toHaveBeenCalledWith(makeBbox(), { speed: "fast" });
    expect(deduplicateChargingStations).toHaveBeenCalledWith([a, b]);
    expect(mapStationToResult).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.id)).toEqual(["a", "b"]);
  });

  it("keeps fulfilled source results when another source fails", async () => {
    const a = makeStation("source-fallback", ["source-a"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("source down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([a]);

    const results = await evChargingProvider.search(makeBbox());

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("source-fallback");
  });

  it("returns empty results when all sources fail", async () => {
    vi.mocked(mocks.sourceA.search).mockRejectedValue(new Error("down"));
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([]);

    await expect(evChargingProvider.search(makeBbox())).resolves.toEqual([]);
  });
});

describe("evChargingProvider.getDetail", () => {
  it("returns merged cached detail after search", async () => {
    const station = makeStation("cached-detail", ["source-a", "source-b"]);
    const detail = {
      id: station.id,
      sources: station.sources,
      name: station.name,
      coordinates: station.coordinates,
      sections: [],
    } satisfies DataSourceDetail;

    vi.mocked(mocks.sourceA.search).mockResolvedValue([station]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([station]);
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    await evChargingProvider.search(makeBbox());
    const result = await evChargingProvider.getDetail("cached-detail");

    expect(result).toBe(detail);
    expect(mocks.sourceA.fetchDetail).not.toHaveBeenCalled();
  });

  it("fetches by source prefix and enriches nearby records on cache miss", async () => {
    const primary = makeStation("source-a:123", ["source-a"]);
    const nearby = makeStation("source-b:456", ["source-b"]);
    const merged = makeStation("source-a:123", ["source-a", "source-b"]);
    vi.mocked(mocks.sourceA.canFetchDetail).mockReturnValue(true);
    vi.mocked(mocks.sourceA.fetchDetail).mockResolvedValue(primary);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([primary]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([nearby]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([merged]);

    const result = await evChargingProvider.getDetail("source-a:123");

    expect(mocks.sourceA.fetchDetail).toHaveBeenCalledWith("source-a:123");
    expect(mocks.sourceA.search).toHaveBeenCalledOnce();
    expect(mocks.sourceB.search).toHaveBeenCalledOnce();
    expect(mapStationToDetail).toHaveBeenCalledWith(merged);
    expect(result?.sources).toEqual(["source-a", "source-b"]);
  });

  it("returns null for an unknown prefix", async () => {
    vi.mocked(mocks.sourceA.canFetchDetail).mockReturnValue(false);
    vi.mocked(mocks.sourceB.canFetchDetail).mockReturnValue(false);

    await expect(evChargingProvider.getDetail("unknown:100")).resolves.toBeNull();
  });
});
