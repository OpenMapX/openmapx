import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedMobilityStation, SharedMobilityVehicle } from "../types.js";

vi.mock("../nextbike-client.js", () => ({
  searchNextbike: vi.fn(),
}));

vi.mock("../citybikes-client.js", () => ({
  searchCityBikes: vi.fn(),
}));

vi.mock("../donkey-client.js", () => ({
  searchDonkey: vi.fn(),
}));

vi.mock("../gbfs-provider-base.js", () => ({
  fetchGbfsData: vi.fn(),
}));

vi.mock("../db-bike-client.js", () => ({
  searchDbBikes: vi.fn(),
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

import { bikeSharingProvider } from "../bike-sharing-provider.js";
import { searchCityBikes } from "../citybikes-client.js";
import { searchDbBikes } from "../db-bike-client.js";
import { dedupStations } from "../dedup.js";
import { searchDonkey } from "../donkey-client.js";
import { fetchGbfsData } from "../gbfs-provider-base.js";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "../mapper.js";
import { fetchMotisRentals } from "../motis-rentals.js";
import { searchNextbike } from "../nextbike-client.js";

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
    source,
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "bicycle",
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
    expect(searchDbBikes).toHaveBeenCalledOnce();
    expect(fetchMotisRentals).toHaveBeenCalledOnce();
    expect(results.length).toBeGreaterThan(0);
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
      source: "nextbike",
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "Nextbike", url: "" },
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
      source: "db",
      name: "Bike",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "DB", url: "" },
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = await bikeSharingProvider.getDetail("bs-db-vehicle-1");
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns fallback detail", async () => {
    const result = await bikeSharingProvider.getDetail("totally-unknown-id-xyz");
    expect(result.id).toBe("totally-unknown-id-xyz");
    expect(result.source).toBe("bike-sharing");
    expect(result.name).toBe("Bike Sharing Station");
    expect(result.coordinates).toEqual([0, 0]);
    expect(result.sections).toEqual([]);
  });
});
