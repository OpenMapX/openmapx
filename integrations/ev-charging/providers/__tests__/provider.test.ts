import type { BoundingBox, DataSourceDetail } from "@openmapx/core";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { evChargingProvider, setManifestDataSources } from "../provider.js";
import { mapStationToDetail, mapStationToResult } from "../station-mapper.js";

// Mirror the manifest dataSources the host loads at runtime so the provider's
// attribution lookup has something to map `source` prefixes against.
beforeEach(() => {
  setManifestDataSources([
    {
      sourceId: "ocm",
      name: "OpenChargeMap",
      url: "https://openchargemap.org/",
      license: "CC-BY-SA-4.0",
      providerCountry: "UK",
      providerPrivacyUrl: "https://openchargemap.org/site/about/privacy",
    },
    {
      sourceId: "source-a",
      name: "Source A",
      url: "https://example.com/a",
      license: "test",
      providerCountry: "XX",
      providerPrivacyUrl: "https://example.com/a/privacy",
    },
    {
      sourceId: "source-b",
      name: "Source B",
      url: "https://example.com/b",
      license: "test",
      providerCountry: "XX",
      providerPrivacyUrl: "https://example.com/b/privacy",
    },
  ]);
});

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

    const envelope = await evChargingProvider.search(makeBbox(), { speed: "fast" });
    const results = envelope.data;

    expect(mocks.sourceA.search).toHaveBeenCalledWith(makeBbox(), { speed: "fast" });
    expect(mocks.sourceB.search).toHaveBeenCalledWith(makeBbox(), { speed: "fast" });
    expect(deduplicateChargingStations).toHaveBeenCalledWith([a, b]);
    expect(mapStationToResult).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.id)).toEqual(["a", "b"]);
    expect(envelope.attributions.map((a) => a.sourceId)).toEqual(["source-a", "source-b"]);
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("keeps fulfilled source results when another source fails", async () => {
    const a = makeStation("source-fallback", ["source-a"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("source down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([a]);

    const results = (await evChargingProvider.search(makeBbox())).data;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("source-fallback");
  });

  it("returns empty results when all sources fail", async () => {
    vi.mocked(mocks.sourceA.search).mockRejectedValue(new Error("down"));
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([]);

    const results = (await evChargingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });

  it("reports hasRealtimeData=true when some merged station is live", async () => {
    const live = { ...makeStation("live-a", ["source-a"]), isLive: true };
    const stale = makeStation("static-b", ["source-b"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([live]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([stale]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([live, stale]);

    const envelope = await evChargingProvider.search(makeBbox());

    expect(envelope.freshness.hasRealtimeData).toBe(true);
  });

  it("reports hasRealtimeData=false when no merged station is live", async () => {
    const a = makeStation("static-a", ["source-a"]);
    const b = makeStation("static-b", ["source-b"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([b]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([a, b]);

    const envelope = await evChargingProvider.search(makeBbox());

    expect(envelope.freshness.hasRealtimeData).toBe(false);
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
    const envelope = await evChargingProvider.getDetail("cached-detail");

    expect(envelope.data).toBe(detail);
    expect(envelope.attributions.map((a) => a.sourceId)).toEqual(["source-a", "source-b"]);
    expect(envelope.freshness.fetchedAt).toBeTruthy();
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

    const result = (await evChargingProvider.getDetail("source-a:123")).data;

    expect(mocks.sourceA.fetchDetail).toHaveBeenCalledWith("source-a:123");
    expect(mocks.sourceA.search).toHaveBeenCalledOnce();
    expect(mocks.sourceB.search).toHaveBeenCalledOnce();
    expect(mapStationToDetail).toHaveBeenCalledWith(merged, expect.any(Function));
    expect(result?.sources).toEqual(["source-a", "source-b"]);
  });

  it("returns null for an unknown prefix", async () => {
    vi.mocked(mocks.sourceA.canFetchDetail).mockReturnValue(false);
    vi.mocked(mocks.sourceB.canFetchDetail).mockReturnValue(false);

    const result = (await evChargingProvider.getDetail("unknown:100")).data;
    expect(result).toBeNull();
  });

  it("reports hasRealtimeData=true for a cached station with isLive set", async () => {
    const live = { ...makeStation("live-detail", ["source-a"]), isLive: true };
    vi.mocked(mocks.sourceA.search).mockResolvedValue([live]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([live]);

    await evChargingProvider.search(makeBbox());
    const envelope = await evChargingProvider.getDetail("live-detail");

    expect(envelope.freshness.hasRealtimeData).toBe(true);
  });

  it("reports hasRealtimeData=false for a cached station without isLive", async () => {
    const stationStatic = makeStation("static-detail", ["source-a"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([stationStatic]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([stationStatic]);

    await evChargingProvider.search(makeBbox());
    const envelope = await evChargingProvider.getDetail("static-detail");

    expect(envelope.freshness.hasRealtimeData).toBe(false);
  });
});
