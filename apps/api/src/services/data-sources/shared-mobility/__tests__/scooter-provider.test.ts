import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedMobilityStation, SharedMobilityVehicle } from "../types.js";

vi.mock("../felyx-client.js", () => ({
  searchFelyx: vi.fn(),
}));

vi.mock("../gosharing-client.js", () => ({
  searchGoSharing: vi.fn(),
}));

vi.mock("../link-client.js", () => ({
  searchLink: vi.fn(),
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

import { dedupStations } from "../dedup.js";
import { searchFelyx } from "../felyx-client.js";
import { fetchGbfsData } from "../gbfs-provider-base.js";
import { searchGoSharing } from "../gosharing-client.js";
import { searchLink } from "../link-client.js";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "../mapper.js";
import { fetchMotisRentals } from "../motis-rentals.js";
import { scooterSharingProvider } from "../scooter-provider.js";

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
    source,
  };
}

function makeVehicle(id: string, source: string): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "scooter_standing",
    isReserved: false,
    isDisabled: false,
    source,
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
  it("GBFS + MOTIS stations deduplicated together", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const motisStation = makeStation("mo1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [motisStation], vehicles: [] });

    await scooterSharingProvider.search(makeBbox());

    const dedupCall = vi.mocked(dedupStations).mock.calls[0][0] as SharedMobilityStation[];
    expect(dedupCall).toHaveLength(2);
    expect(dedupCall[0].id).toBe("gbfs1");
    expect(dedupCall[1].id).toBe("mo1");
  });

  it("vehicles from all 5 sources collected (GBFS, Felyx, GO Sharing, Link, MOTIS)", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const gbfsVehicle = makeVehicle("gbfs-v1", "gbfs");
    const felyxVehicle = makeVehicle("felyx-v1", "felyx");
    const goVehicle = makeVehicle("go-v1", "gosharing");
    const linkVehicle = makeVehicle("link-v1", "link");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [gbfsVehicle] });
    vi.mocked(searchFelyx).mockResolvedValue([felyxVehicle]);
    vi.mocked(searchGoSharing).mockResolvedValue([goVehicle]);
    vi.mocked(searchLink).mockResolvedValue([linkVehicle]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [motisVehicle] });
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await scooterSharingProvider.search(makeBbox());

    expect(mapVehicleToResult).toHaveBeenCalledTimes(5);
    expect(mapVehicleToResult).toHaveBeenCalledWith(gbfsVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(felyxVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(goVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(linkVehicle);
    expect(mapVehicleToResult).toHaveBeenCalledWith(motisVehicle);
    expect(results).toHaveLength(5);
  });

  it("stations + vehicles combined in results", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    const gbfsStation = makeStation("gbfs-s1", "gbfs");
    const felyxVehicle = makeVehicle("felyx-v1-combo", "felyx");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([felyxVehicle]);
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([gbfsStation]);

    const results = await scooterSharingProvider.search(makeBbox());

    // 1 station + 1 vehicle
    expect(results).toHaveLength(2);
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockRejectedValue(new Error("down"));
    vi.mocked(searchGoSharing).mockResolvedValue([makeVehicle("go-v1-solo", "gosharing")]);
    vi.mocked(searchLink).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await scooterSharingProvider.search(makeBbox());

    // Only GO Sharing vehicle survives
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("go-v1-solo");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockRejectedValue(new Error("down"));
    vi.mocked(searchGoSharing).mockRejectedValue(new Error("down"));
    vi.mocked(searchLink).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = await scooterSharingProvider.search(makeBbox());
    expect(results).toEqual([]);
  });

  it("fetches GBFS with scooter form factors and 'other' exclude", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
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
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    await scooterSharingProvider.search(makeBbox());

    const bbox = makeBbox();
    expect(fetchMotisRentals).toHaveBeenCalledWith(
      [bbox.west, bbox.south, bbox.east, bbox.north],
      ["scooter_standing", "scooter_seated", "moped"],
    );
  });
});

// getDetail()

describe("scooterSharingProvider.getDetail", () => {
  it("station cache hit calls mapStationToDetail", async () => {
    const station = makeStation("sc-cached-s1", "gbfs");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([station]);
    vi.mocked(mapStationToResult).mockReturnValue(makeResult("sc-cached-s1"));
    await scooterSharingProvider.search(makeBbox());

    const detail = {
      id: "sc-cached-s1",
      source: "gbfs",
      name: "Station",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "GBFS", url: "" },
      sections: [],
    };
    vi.mocked(mapStationToDetail).mockReturnValue(detail);

    const result = await scooterSharingProvider.getDetail("sc-cached-s1");
    expect(mapStationToDetail).toHaveBeenCalledWith(station);
    expect(result).toBe(detail);
  });

  it("vehicle cache hit calls mapVehicleToDetail", async () => {
    const vehicle = makeVehicle("sc-felyx-v1", "felyx");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([vehicle]);
    vi.mocked(searchGoSharing).mockResolvedValue([]);
    vi.mocked(searchLink).mockResolvedValue([]);
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);
    vi.mocked(mapVehicleToResult).mockReturnValue(makeResult("sc-felyx-v1"));
    await scooterSharingProvider.search(makeBbox());

    const detail = {
      id: "sc-felyx-v1",
      source: "felyx",
      name: "Scooter",
      coordinates: [11.5, 48.5] as [number, number],
      attribution: { text: "Felyx", url: "" },
      sections: [],
    };
    vi.mocked(mapVehicleToDetail).mockReturnValue(detail);

    const result = await scooterSharingProvider.getDetail("sc-felyx-v1");
    expect(mapVehicleToDetail).toHaveBeenCalledWith(vehicle);
    expect(result).toBe(detail);
  });

  it("cache miss returns fallback detail", async () => {
    const result = await scooterSharingProvider.getDetail("totally-unknown-sc-id");
    expect(result.id).toBe("totally-unknown-sc-id");
    expect(result.source).toBe("scooter-sharing");
    expect(result.name).toBe("E-Scooter");
    expect(result.coordinates).toEqual([0, 0]);
    expect(result.sections).toEqual([]);
  });
});
