import {
  createSharedMobilityProviderFixtures,
  createSharedMobilityTestRuntime,
  fetchMotisRentals,
  createSharedMobilityBbox as makeBbox,
  sharedMobilityProviderContract,
} from "@openmapx/integration-framework/test/shared-mobility-provider";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { describe, expect, it, vi } from "vitest";

vi.mock("../providers/nextbike-client.js", () => ({
  searchNextbike: vi.fn(),
}));

vi.mock("../providers/citybikes-client.js", () => ({
  searchCityBikes: vi.fn(),
}));

vi.mock("../providers/donkey-client.js", () => ({
  searchDonkey: vi.fn(),
}));

const dbBikeMocks = vi.hoisted(() => ({ searchDbBikes: vi.fn() }));

vi.mock("../providers/db-bike-client.js", () => ({
  createDbBikeClient: () => dbBikeMocks.searchDbBikes,
}));

import {
  mapStationToResult,
  mapVehicleToResult,
} from "@openmapx/integration-framework/test/shared-mobility-provider";
import { dedupStations } from "@openmapx/mobility-core/dedup";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/mobility-core/gbfs-provider-base";
import { searchCityBikes } from "../providers/citybikes-client.js";
import { searchDonkey } from "../providers/donkey-client.js";
import { searchNextbike } from "../providers/nextbike-client.js";
import { createBikeSharingProvider } from "../providers/provider.js";

const { searchDbBikes } = dbBikeMocks;
const bikeSharingProvider = createBikeSharingProvider({
  runtime: createSharedMobilityTestRuntime(),
  dataSources: [],
  searchCityBikes,
  searchDbBikes,
  searchDonkey,
  searchNextbike,
});

const fixtures = createSharedMobilityProviderFixtures("bike-sharing", "bicycle");
const { makeResult, makeStation, makeVehicle } = fixtures;

describe("bikeSharingProvider.search", () => {
  it("fetches every source and prioritizes MOTIS before fallback stations", async () => {
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
});

sharedMobilityProviderContract({
  name: "bike sharing",
  provider: bikeSharingProvider,
  fixtures,
  formFactors: ["bicycle", "cargo_bicycle"],
  mapContextOptions: { systemIds: ["voioslo"], vehicleTypeIds: ["scooter"] },
  arrangeInventory({ station, vehicle }) {
    vi.mocked(searchNextbike).mockResolvedValue([]);
    vi.mocked(searchCityBikes).mockResolvedValue([]);
    vi.mocked(searchDonkey).mockResolvedValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [] });
    vi.mocked(searchDbBikes).mockResolvedValue({ stations: [], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
  },
});
