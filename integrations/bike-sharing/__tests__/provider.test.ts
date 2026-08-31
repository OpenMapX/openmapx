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

vi.mock("../providers/db-bike-client.js", () => ({
  searchDbBikes: vi.fn(),
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
import { mapStationToResult, mapVehicleToResult } from "@openmapx/mobility-core/mapper";
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import { buildSharedMobilityMapContext } from "@openmapx/mobility-core/shared-mobility-context";
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

    const results = (await bikeSharingProvider.search(makeBbox())).data;

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

    const results = (
      await bikeSharingProvider.search({
        south: 46.9,
        west: 7.3,
        north: 47.0,
        east: 7.5,
      })
    ).data;

    expect(fetchSwissSharedMobilityDataForBbox).toHaveBeenCalledOnce();
    expect(results).toEqual([makeResult("ch-station-1")]);
  });

  it("station order: MOTIS is authoritative before direct metadata/fallback sources", async () => {
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
    expect(dedupCall.map((station) => station.id)).toEqual([
      "mo1",
      "nb1",
      "cb1",
      "dk1",
      "gbfs1",
      "db1",
    ]);
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

    const results = (await bikeSharingProvider.search(makeBbox())).data;

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

    const results = (await bikeSharingProvider.search(makeBbox())).data;
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

    const results = (await bikeSharingProvider.search(makeBbox())).data;

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

    expect(enrichEnturMobilityItems).toHaveBeenCalledWith([station], [vehicle], { scope: "map" });
  });
});

describe("bikeSharingProvider configuration", () => {
  it("delegates map context to the MOTIS-first shared builder", async () => {
    const bbox = makeBbox();
    const options = { systemIds: ["voioslo"], vehicleTypeIds: ["scooter"] };

    await bikeSharingProvider.getMapContext(bbox, {}, options);

    expect(buildSharedMobilityMapContext).toHaveBeenCalledWith(
      bbox,
      new Set(["bicycle", "cargo_bicycle"]),
      options,
    );
  });
});
