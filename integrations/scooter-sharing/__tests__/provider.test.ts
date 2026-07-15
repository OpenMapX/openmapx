import type {
  BoundingBox,
  DataSourceResult,
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/felyx-client.js", () => ({
  searchFelyx: vi.fn(),
}));

vi.mock("../providers/nrw-mobidrom-client.js", () => ({
  searchNrwMobidrom: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/gbfs-provider-base", () => ({
  fetchGbfsData: vi.fn(),
  fetchSwissSharedMobilityDataForBbox: vi.fn().mockResolvedValue({ stations: [], vehicles: [] }),
}));

vi.mock("@openmapx/mobility-core/entur-mobility", () => ({
  enrichEnturMobilityItems: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@openmapx/mobility-core/shared-mobility-context", () => ({
  buildSharedMobilityMapContext: vi.fn().mockResolvedValue(null),
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
  stripMobilityKindPrefix: (id: string) =>
    id.startsWith("s:") || id.startsWith("v:") ? id.slice(2) : id,
}));

import { dedupStations } from "@openmapx/mobility-core/dedup";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
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
import { buildSharedMobilityMapContext } from "@openmapx/mobility-core/shared-mobility-context";
import { searchFelyx } from "../providers/felyx-client.js";
import { searchNrwMobidrom } from "../providers/nrw-mobidrom-client.js";
import { scooterSharingProvider } from "../providers/provider.js";

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
    availableVehicles: 4,
    vehicleTypes: ["scooter_standing"],
    isActive: true,
    sources: [source],
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "scooter_standing",
    isReserved: false,
    isDisabled: false,
    sources: [source],
  };
}

function makeResult(id: string): DataSourceResult {
  return {
    id,
    name: `Item ${id}`,
    coordinates: [11.5, 48.5],
    source: "scooter-sharing",
    variant: "available",
    status: "available",
  };
}

// search()

describe("scooterSharingProvider.search", () => {
  it("GBFS + NRW + MOTIS stations deduplicated together", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const nrwStation = makeStation("nrw1", "nrw-mobidrom-scooter");
    const motisStation = makeStation("mo1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [nrwStation], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [motisStation], vehicles: [] });

    await scooterSharingProvider.search(makeBbox());

    const dedupCall = vi.mocked(dedupStations).mock.calls[0][0] as SharedMobilityStation[];
    expect(fetchSwissSharedMobilityDataForBbox).toHaveBeenCalledOnce();
    expect(dedupCall).toHaveLength(3);
    expect(dedupCall.map((station) => station.id)).toEqual(["mo1", "gbfs1", "nrw1"]);
  });

  it("vehicles from all 4 sources collected (GBFS, Felyx, NRW, MOTIS)", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const gbfsVehicle = makeVehicle("gbfs-v1", "gbfs");
    const felyxVehicle = makeVehicle("felyx-v1", "felyx");
    const nrwVehicle = makeVehicle("nrw-v1", "nrw-mobidrom-scooter");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [gbfsVehicle] });
    vi.mocked(searchFelyx).mockResolvedValue([felyxVehicle]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [nrwVehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [motisVehicle] });
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;

    expect(mapVehicleToResult).toHaveBeenCalledTimes(4);
    expect(mapVehicleToResult).toHaveBeenCalledWith(gbfsVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(felyxVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(nrwVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(motisVehicle);
    expect(results).toHaveLength(4);
  });

  it("stations + vehicles combined in results", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const gbfsStation = makeStation("gbfs-s1", "gbfs");
    const felyxVehicle = makeVehicle("felyx-v1-combo", "felyx");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([felyxVehicle]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([gbfsStation]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;

    // 1 station + 1 vehicle
    expect(results).toHaveLength(2);
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockResolvedValue([makeVehicle("felyx-v1-solo", "felyx")]);
    vi.mocked(searchNrwMobidrom).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;

    // Only Felyx vehicle survives
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("felyx-v1-solo");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockRejectedValue(new Error("down"));
    vi.mocked(searchNrwMobidrom).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });

  it("fetches GBFS with scooter form factors and 'other' exclude", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    await scooterSharingProvider.search(makeBbox());

    expect(fetchGbfsData).toHaveBeenCalledWith(makeBbox(), expect.any(Set), "other");
    const formFactors = vi.mocked(fetchGbfsData).mock.calls[0][1] as Set<string>;
    expect(formFactors.has("scooter_standing")).toBe(true);
    expect(formFactors.has("scooter_seated")).toBe(true);
    expect(formFactors.has("moped")).toBe(true);
  });

  it("MOTIS called with scooter form factors", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    await scooterSharingProvider.search(makeBbox());

    const bbox = makeBbox();
    expect(fetchMotisRentals).toHaveBeenCalledWith(
      [bbox.west, bbox.south, bbox.east, bbox.north],
      ["scooter_standing", "scooter_seated", "moped"],
    );
  });

  it("NRW Mobidrom called with same bbox", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    const bbox = makeBbox();
    await scooterSharingProvider.search(bbox);

    expect(searchNrwMobidrom).toHaveBeenCalledWith(bbox);
  });

  it("runs Entur enrichment on deduplicated stations and vehicles", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const station = makeStation("gbfs-station", "gbfs");
    const vehicle = makeVehicle("gbfs-vehicle", "gbfs");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [vehicle] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);

    await scooterSharingProvider.search(makeBbox());

    expect(enrichEnturMobilityItems).toHaveBeenCalledWith([station], [vehicle], { scope: "map" });
  });
});

// getDetail()

describe("scooterSharingProvider.getDetail", () => {
  it("station cache hit calls mapStationToDetail", async () => {
    const station = makeStation("sc-cached-s1", "gbfs");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);
    vi.mocked(mapStationToResult).mockReturnValue(makeResult("sc-cached-s1"));
    await scooterSharingProvider.search(makeBbox());

    const detail = {
      id: "sc-cached-s1",
      sources: ["gbfs"],
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    const result = (await scooterSharingProvider.getDetail("sc-cached-s1")).data;
    expect(mapStationToDetail).toHaveBeenCalledWith(station);
    expect(result).toBe(detail);
  });

  it("vehicle cache hit calls mapVehicleToDetail", async () => {
    const vehicle = makeVehicle("sc-felyx-v1", "felyx");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([vehicle]);
    vi.mocked(searchNrwMobidrom).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);
    vi.mocked(mapVehicleToResult).mockReturnValue(makeResult("sc-felyx-v1"));
    await scooterSharingProvider.search(makeBbox());

    const detail = {
      id: "sc-felyx-v1",
      sources: ["felyx"],
      name: "Scooter",
      coordinates: [11.5, 48.5] as [number, number],
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = (await scooterSharingProvider.getDetail("sc-felyx-v1")).data;
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns null", async () => {
    const result = (await scooterSharingProvider.getDetail("totally-unknown-sc-id")).data;
    expect(result).toBeNull();
  });

  it("delegates map context to the MOTIS-first shared builder", async () => {
    const bbox = makeBbox();
    const options = { systemIds: ["voioslo"], vehicleTypeIds: ["scooter"] };

    await scooterSharingProvider.getMapContext(bbox, {}, options);

    expect(buildSharedMobilityMapContext).toHaveBeenCalledWith(
      bbox,
      new Set(["scooter_standing", "scooter_seated", "moped"]),
      options,
    );
  });
});
