import type {
  BoundingBox,
  DataSourceResult,
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/nextbike-client.js", () => ({
  searchNextbike: vi.fn(),
}));

vi.mock("../providers/citybikes-client.js", () => ({
  searchCityBikes: vi.fn(),
}));

vi.mock("../providers/donkey-client.js", () => ({
  searchDonkey: vi.fn(),
}));

vi.mock("@openmapx/shared-mobility/gbfs-provider-base", () => ({
  fetchGbfsData: vi.fn(),
  fetchSwissSharedMobilityDataForBbox: vi.fn().mockResolvedValue({ stations: [], vehicles: [] }),
}));

vi.mock("@openmapx/shared-mobility/entur-mobility", () => ({
  enrichEnturMobilityItems: vi.fn().mockResolvedValue(undefined),
  buildEnturGeofencingMapContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("../providers/db-bike-client.js", () => ({
  searchDbBikes: vi.fn(),
}));

vi.mock("@openmapx/shared-mobility/motis-rentals", () => ({
  fetchMotisRentals: vi.fn(),
}));

vi.mock("@openmapx/shared-mobility/dedup", () => ({
  dedupStations: vi.fn((items: unknown[]) => items),
  dedupVehicles: vi.fn((items: unknown[]) => items),
}));

vi.mock("@openmapx/shared-mobility/mapper", () => ({
  mapStationToResult: vi.fn(),
  mapStationToDetail: vi.fn(),
  mapVehicleToResult: vi.fn(),
  mapVehicleToDetail: vi.fn(),
}));

import { dedupStations } from "@openmapx/shared-mobility/dedup";
import {
  buildEnturGeofencingMapContext,
  enrichEnturMobilityItems,
} from "@openmapx/shared-mobility/entur-mobility";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/shared-mobility/gbfs-provider-base";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "@openmapx/shared-mobility/mapper";
import { fetchMotisRentals } from "@openmapx/shared-mobility/motis-rentals";
import { searchCityBikes } from "../providers/citybikes-client.js";
import { searchDbBikes } from "../providers/db-bike-client.js";
import { searchDonkey } from "../providers/donkey-client.js";
import { searchNextbike } from "../providers/nextbike-client.js";
import { bikeSharingProvider } from "../providers/provider.js";

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
    availableVehicles: 5,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: [source],
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "bicycle",
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
    source: "bike-sharing",
    variant: "available",
    status: "available",
  };
}

// search()

describe("bikeSharingProvider.search", () => {
  it("fetches 6 sources in parallel", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    vi.mocked(searchNextbike).mockResolvedValue([makeStation("nb1", "nextbike")]);
    vi.mocked(searchCityBikes).mockResolvedValue([makeStation("cb1", "citybikes")]);
    vi.mocked(searchDonkey).mockResolvedValue([makeStation("dk1", "donkey")]);
    vi.mocked(fetchGbfsData).mockResolvedValue({
      stations: [makeStation("gbfs1", "gbfs")],
      vehicles: [],
    });
    vi.mocked(searchDbBikes).mockResolvedValue({
      stations: [makeStation("db1", "db")],
      vehicles: [],
    });
    vi.mocked(fetchMotisRentals).mockResolvedValue({
      stations: [makeStation("mo1", "motis")],
      vehicles: [],
    });

    const results = await bikeSharingProvider.search(makeBbox());

    expect(searchNextbike).toHaveBeenCalledOnce();
    expect(searchCityBikes).toHaveBeenCalledOnce();
    expect(searchDonkey).toHaveBeenCalledOnce();
    expect(fetchGbfsData).toHaveBeenCalledOnce();
    expect(fetchSwissSharedMobilityDataForBbox).toHaveBeenCalledOnce();
    expect(searchDbBikes).toHaveBeenCalledOnce();
    expect(fetchMotisRentals).toHaveBeenCalledOnce();
    expect(results.length).toBeGreaterThan(0);
  });

  it("merges Swiss sharedmobility.ch coverage when the bbox overlaps Switzerland", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchSwissSharedMobilityDataForBbox).mockResolvedValue({
      stations: [makeStation("ch-station-1", "gbfs/sharedmobility.ch")],
      vehicles: [],
    });
    vi.mocked(searchNextbike).mockResolvedValue([]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(searchDbBikes).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });

    const results = await bikeSharingProvider.search({
      south: 46.9,
      west: 7.3,
      north: 47.0,
      east: 7.5,
    });

    expect(fetchSwissSharedMobilityDataForBbox).toHaveBeenCalledOnce();
    expect(results).toEqual([makeResult("ch-station-1")]);
  });

  it("station order: Nextbike > CityBikes > Donkey > GBFS > DB > MOTIS", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(searchNextbike).mockResolvedValue([makeStation("nb1", "nextbike")]);
    vi.mocked(searchCityBikes).mockResolvedValue([makeStation("cb1", "citybikes")]);
    vi.mocked(searchDonkey).mockResolvedValue([makeStation("dk1", "donkey")]);
    vi.mocked(fetchGbfsData).mockResolvedValue({
      stations: [makeStation("gbfs1", "gbfs")],
      vehicles: [],
    });
    vi.mocked(searchDbBikes).mockResolvedValue({
      stations: [makeStation("db1", "db")],
      vehicles: [],
    });
    vi.mocked(fetchMotisRentals).mockResolvedValue({
      stations: [makeStation("mo1", "motis")],
      vehicles: [],
    });

    await bikeSharingProvider.search(makeBbox());

    const dedupCall = vi.mocked(dedupStations).mock.calls[0][0] as SharedMobilityStation[];
    expect(dedupCall[0].id).toBe("nb1");
    expect(dedupCall[1].id).toBe("cb1");
    expect(dedupCall[2].id).toBe("dk1");
    expect(dedupCall[3].id).toBe("gbfs1");
    expect(dedupCall[4].id).toBe("db1");
    expect(dedupCall[5].id).toBe("mo1");
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(searchNextbike).mockRejectedValue(new Error("down"));
    vi.mocked(searchCityBikes).mockRejectedValue(new Error("down"));
    vi.mocked(searchDonkey).mockRejectedValue(new Error("down"));
    vi.mocked(fetchGbfsData).mockResolvedValue({
      stations: [makeStation("gbfs1", "gbfs")],
      vehicles: [],
    });
    vi.mocked(searchDbBikes).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));

    const results = await bikeSharingProvider.search(makeBbox());

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("gbfs1");
  });

  it("all 6 sources fail → returns empty array", async () => {
    vi.mocked(searchNextbike).mockRejectedValue(new Error("down"));
    vi.mocked(searchCityBikes).mockRejectedValue(new Error("down"));
    vi.mocked(searchDonkey).mockRejectedValue(new Error("down"));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchDbBikes).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await bikeSharingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });

  it("DB + MOTIS vehicles added after stations", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const dbVehicle = makeVehicle("db-v1", "db");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(searchNextbike).mockResolvedValue([]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchDbBikes).mockResolvedValue({
      stations: [makeStation("db-s1", "db")],
      vehicles: [dbVehicle],
    });
    vi.mocked(fetchMotisRentals).mockResolvedValue({
      stations: [],
      vehicles: [motisVehicle],
    });
    vi.mocked(dedupStations).mockReturnValue([makeStation("db-s1", "db")]);

    const results = await bikeSharingProvider.search(makeBbox());

    expect(mapVehicleToResult).toHaveBeenCalledWith(dbVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(motisVehicle);
    expect(results).toHaveLength(3);
  });

  it("runs Entur enrichment on deduplicated stations and vehicles", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const station = makeStation("gbfs-station", "gbfs");
    const vehicle = makeVehicle("db-vehicle", "db");

    vi.mocked(searchNextbike).mockResolvedValue([]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [] });
    vi.mocked(searchDbBikes).mockResolvedValue({ stations: [], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);

    await bikeSharingProvider.search(makeBbox());

    expect(enrichEnturMobilityItems).toHaveBeenCalledWith([station], [vehicle]);
  });
});

// getDetail()

describe("bikeSharingProvider.getDetail", () => {
  it("station cache hit calls mapStationToDetail", async () => {
    // Populate cache via search
    const station = makeStation("bs-cached-station", "nextbike");
    vi.mocked(searchNextbike).mockResolvedValue([station]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchDbBikes).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);
    vi.mocked(mapStationToResult).mockReturnValue(makeResult("bs-cached-station"));
    await bikeSharingProvider.search(makeBbox());

    const detail = {
      id: "bs-cached-station",
      sources: ["nextbike"],
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    const result = await bikeSharingProvider.getDetail("bs-cached-station");
    expect(mapStationToDetail).toHaveBeenCalledWith(station);
    expect(result).toBe(detail);
  });

  it("vehicle cache hit calls mapVehicleToDetail", async () => {
    const vehicle = makeVehicle("bs-db-vehicle-1", "db");
    vi.mocked(searchNextbike).mockResolvedValue([]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchDbBikes).mockResolvedValue({ stations: [], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);
    vi.mocked(mapVehicleToResult).mockReturnValue(makeResult("bs-db-vehicle-1"));
    await bikeSharingProvider.search(makeBbox());

    const detail = {
      id: "bs-db-vehicle-1",
      sources: ["db"],
      name: "Bike",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = await bikeSharingProvider.getDetail("bs-db-vehicle-1");
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns null", async () => {
    const result = await bikeSharingProvider.getDetail("totally-unknown-id-xyz");
    expect(result).toBeNull();
  });

  it("delegates map context to Entur geofencing builder", async () => {
    const bbox = makeBbox();
    const options = { systemIds: ["voioslo"], vehicleTypeIds: ["scooter"] };

    await bikeSharingProvider.getMapContext(bbox, {}, options);

    expect(buildEnturGeofencingMapContext).toHaveBeenCalledWith(bbox, options);
  });
});
