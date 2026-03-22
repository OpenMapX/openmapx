import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedMobilityStation, SharedMobilityVehicle } from "../types.js";

vi.mock("../car-sharing-registry.js", () => ({
  searchRegionalClients: vi.fn(),
}));

vi.mock("../gbfs-provider-base.js", () => ({
  fetchGbfsData: vi.fn(),
}));

vi.mock("../motis-rentals.js", () => ({
  fetchMotisRentals: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  dedupStations: vi.fn((items: unknown[]) => items),
}));

vi.mock("../mapper.js", () => ({
  mapStationToResult: vi.fn(),
  mapStationToDetail: vi.fn(),
  mapVehicleToResult: vi.fn(),
  mapVehicleToDetail: vi.fn(),
}));

vi.mock("../merge-stations.js", () => ({
  mergeRegionalStations: vi.fn((items: unknown[]) => items),
}));

import { carSharingProvider } from "../car-sharing-provider.js";
import { searchRegionalClients } from "../car-sharing-registry.js";
import { dedupStations } from "../dedup.js";
import { fetchGbfsData } from "../gbfs-provider-base.js";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "../mapper.js";
import { mergeRegionalStations } from "../merge-stations.js";
import { fetchMotisRentals } from "../motis-rentals.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeStation(id: string, source: string): SharedMobilityStation {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    availableVehicles: 3,
    vehicleTypes: ["car"],
    isActive: true,
    source,
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "car",
    isReserved: false,
    isDisabled: false,
    source,
  };
}

function makeResult(id: string): DataSourceResult {
  return {
    id,
    name: `Station ${id}`,
    coordinates: [11.5, 48.5],
    source: "car-sharing",
    variant: "available",
    status: "available",
  };
}

// search()

describe("carSharingProvider.search", () => {
  it("regional stations merged first via mergeRegionalStations", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const regional = [makeStation("reg1", "cambio"), makeStation("reg2", "stadtmobil")];
    vi.mocked(searchRegionalClients).mockResolvedValue(regional);
    vi.mocked(mergeRegionalStations).mockReturnValue(regional);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await carSharingProvider.search(makeBbox());

    expect(mergeRegionalStations).toHaveBeenCalledWith(regional);
    expect(mapStationToResult).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it("GBFS + MOTIS stations deduplicated together", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const motisStation = makeStation("mo1", "motis");

    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("skip"));
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [motisStation], vehicles: [] });

    await carSharingProvider.search(makeBbox());

    const dedupCall = vi.mocked(dedupStations).mock.calls[0][0] as SharedMobilityStation[];
    expect(dedupCall).toHaveLength(2);
    expect(dedupCall[0].id).toBe("gbfs1");
    expect(dedupCall[1].id).toBe("mo1");
  });

  it("vehicles from GBFS + MOTIS added after stations", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const gbfsVehicle = makeVehicle("gbfs-v1", "gbfs");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("skip"));
    vi.mocked(fetchGbfsData).mockResolvedValue({
      stations: [],
      vehicles: [gbfsVehicle],
    });
    vi.mocked(fetchMotisRentals).mockResolvedValue({
      stations: [],
      vehicles: [motisVehicle],
    });
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await carSharingProvider.search(makeBbox());

    expect(mapVehicleToResult).toHaveBeenCalledWith(gbfsVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(motisVehicle);
    expect(results).toHaveLength(2);
  });

  it("regional + GBFS + MOTIS all contribute to results", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const regStation = makeStation("reg1", "cambio");
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(searchRegionalClients).mockResolvedValue([regStation]);
    vi.mocked(mergeRegionalStations).mockReturnValue([regStation]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [motisVehicle] });
    vi.mocked(dedupStations).mockReturnValue([gbfsStation]);

    const results = await carSharingProvider.search(makeBbox());

    // 1 regional + 1 GBFS station + 1 MOTIS vehicle
    expect(results).toHaveLength(3);
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("down"));
    vi.mocked(fetchGbfsData).mockResolvedValue({
      stations: [makeStation("gbfs1", "gbfs")],
      vehicles: [],
    });
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([makeStation("gbfs1", "gbfs")]);

    const results = await carSharingProvider.search(makeBbox());

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("gbfs1");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("down"));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await carSharingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });
});

// getDetail()

describe("carSharingProvider.getDetail", () => {
  it("station cache hit calls mapStationToDetail", async () => {
    // Use unique IDs to avoid cache collisions with other tests
    const station = makeStation("cs-cached-station", "cambio");
    vi.mocked(searchRegionalClients).mockResolvedValue([station]);
    vi.mocked(mergeRegionalStations).mockReturnValue([station]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);
    vi.mocked(mapStationToResult).mockReturnValue(makeResult("cs-cached-station"));
    await carSharingProvider.search(makeBbox());

    const detail = {
      id: "cs-cached-station",
      source: "cambio",
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "Cambio", url: "" },
      sections: [],
    };
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    const result = await carSharingProvider.getDetail("cs-cached-station");
    expect(mapStationToDetail).toHaveBeenCalledWith(station);
    expect(result).toBe(detail);
  });

  it("vehicle cache hit calls mapVehicleToDetail", async () => {
    const vehicle = makeVehicle("cs-gbfs-v1", "gbfs");
    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("skip"));
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);
    vi.mocked(mapVehicleToResult).mockReturnValue(makeResult("cs-gbfs-v1"));
    await carSharingProvider.search(makeBbox());

    const detail = {
      id: "cs-gbfs-v1",
      source: "gbfs",
      name: "Car",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "GBFS", url: "" },
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = await carSharingProvider.getDetail("cs-gbfs-v1");
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns fallback detail", async () => {
    const result = await carSharingProvider.getDetail("totally-unknown-cs-id");
    expect(result.id).toBe("totally-unknown-cs-id");
    expect(result.source).toBe("car-sharing");
    expect(result.name).toBe("Car Sharing Station");
    expect(result.coordinates).toEqual([0, 0]);
    expect(result.sections).toEqual([]);
  });
});
