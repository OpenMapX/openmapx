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
import { evChargingProvider, setLogger, setManifestDataSources } from "../provider.js";

function makeBbox() {
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

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  setManifestDataSources([
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
  // Reset logger after each test
  const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  setLogger(noopLogger);
});

describe("evChargingProvider.search failure handling", () => {
  it("returns healthy results and warns once when one source rejects", async () => {
    const fakeLogger = makeFakeLogger();
    setLogger(fakeLogger);

    const a = makeStation("a", ["source-a"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("source-b down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([a]);

    const envelope = await evChargingProvider.search(makeBbox());

    expect(envelope.data).toHaveLength(1);
    expect(envelope.data[0].id).toBe("a");
    expect(fakeLogger.warn).toHaveBeenCalledOnce();
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("source-b"),
      expect.any(Error),
    );
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("returns empty data and logs error when all sources reject", async () => {
    const fakeLogger = makeFakeLogger();
    setLogger(fakeLogger);

    vi.mocked(mocks.sourceA.search).mockRejectedValue(new Error("down"));
    vi.mocked(mocks.sourceB.search).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateChargingStations).mockReturnValue([]);

    const envelope = await evChargingProvider.search(makeBbox());

    expect(envelope.data).toEqual([]);
    expect(fakeLogger.warn).toHaveBeenCalledTimes(2);
    expect(fakeLogger.error).toHaveBeenCalledOnce();
    expect(fakeLogger.error).toHaveBeenCalledWith("all ev-charging sources failed");
  });

  it("logs nothing on happy path when all sources resolve", async () => {
    const fakeLogger = makeFakeLogger();
    setLogger(fakeLogger);

    const a = makeStation("a", ["source-a"]);
    const b = makeStation("b", ["source-b"]);
    vi.mocked(mocks.sourceA.search).mockResolvedValue([a]);
    vi.mocked(mocks.sourceB.search).mockResolvedValue([b]);
    vi.mocked(deduplicateChargingStations).mockReturnValue([a, b]);

    await evChargingProvider.search(makeBbox());

    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });
});
