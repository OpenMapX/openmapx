import type {
  BoundingBox,
  DataSourceResult,
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/registry.js", () => ({
  searchRegionalClients: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/gbfs-provider-base", () => ({
  fetchGbfsData: vi.fn(),
  fetchSwissSharedMobilityDataForBbox: vi.fn().mockResolvedValue({ stations: [], vehicles: [] }),
}));

vi.mock("@openmapx/mobility-core/entur-mobility", () => ({
  enrichEnturMobilityItems: vi.fn().mockResolvedValue(undefined),
  buildEnturGeofencingMapContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@openmapx/mobility-core/motis-rentals", () => ({
  fetchMotisRentals: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/dedup", () => ({
  dedupStations: vi.fn((items: unknown[]) => items),
  dedupVehicles: vi.fn((items: unknown[]) => items),
}));

vi.mock("@openmapx/mobility-core/mapper", () => ({
  mapStationToResult: vi.fn(),
  mapStationToDetail: vi.fn(),
  mapVehicleToResult: vi.fn(),
  mapVehicleToDetail: vi.fn(),
}));

vi.mock("../providers/merge-stations.js", () => ({
  mergeRegionalStations: vi.fn((items: unknown[]) => items),
}));

import { dedupStations } from "@openmapx/mobility-core/dedup";
import {
  buildEnturGeofencingMapContext,
  enrichEnturMobilityItems,
} from "@openmapx/mobility-core/entur-mobility";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/mobility-core/gbfs-provider-base";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "@openmapx/mobility-core/mapper";
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import { mergeRegionalStations } from "../providers/merge-stations.js";
import { carSharingProvider } from "../providers/provider.js";
import { searchRegionalClients } from "../providers/registry.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSwissSharedMobilityDataForBbox).mockResolvedValue({
    stations: [],
    vehicles: [],
  });
});

afterEach(() => {
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
    sources: [source],
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "car",
    isReserved: false,
    isDisabled: false,
    sources: [source],
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

    const results = (await carSharingProvider.search(makeBbox())).data;

    expect(fetchSwissSharedMobilityDataForBbox).toHaveBeenCalledOnce();
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

    const results = (await carSharingProvider.search(makeBbox())).data;

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

    const results = (await carSharingProvider.search(makeBbox())).data;

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

    const results = (await carSharingProvider.search(makeBbox())).data;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("gbfs1");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(searchRegionalClients).mockRejectedValue(new Error("down"));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await carSharingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });

  it("runs Entur enrichment on deduplicated stations and vehicles", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const station = makeStation("gbfs-station", "gbfs");
    const vehicle = makeVehicle("gbfs-vehicle", "gbfs");

    vi.mocked(searchRegionalClients).mockResolvedValue([]);
    vi.mocked(mergeRegionalStations).mockReturnValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);

    await carSharingProvider.search(makeBbox());

    expect(enrichEnturMobilityItems).toHaveBeenCalledWith([station], [vehicle]);
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
      sources: ["cambio"],
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    const result = (await carSharingProvider.getDetail("cs-cached-station")).data;
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
      sources: ["gbfs"],
      name: "Car",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = (await carSharingProvider.getDetail("cs-gbfs-v1")).data;
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns null", async () => {
    const result = (await carSharingProvider.getDetail("totally-unknown-cs-id")).data;
    expect(result).toBeNull();
  });

  it("delegates map context to Entur geofencing builder", async () => {
    const bbox = makeBbox();
    const options = { systemIds: ["bilkollektivet"], vehicleTypeIds: ["car"] };

    await carSharingProvider.getMapContext(bbox, {}, options);

    expect(buildEnturGeofencingMapContext).toHaveBeenCalledWith(bbox, options);
  });
});
