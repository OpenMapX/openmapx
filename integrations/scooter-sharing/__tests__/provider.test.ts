import {
  createSharedMobilityProviderFixtures,
  createSharedMobilityBbox as makeBbox,
  sharedMobilityProviderContract,
} from "@openmapx/integration-framework/test/shared-mobility-provider";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { describe, expect, it, vi } from "vitest";

vi.mock("../providers/felyx-client.js", () => ({
  searchFelyx: vi.fn(),
}));

vi.mock("../providers/de-nw-mobidrom-scooter-client.js", () => ({
  searchDeNwMobidromScooter: vi.fn(),
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
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import { searchDeNwMobidromScooter } from "../providers/de-nw-mobidrom-scooter-client.js";
import { searchFelyx } from "../providers/felyx-client.js";
import { scooterSharingProvider } from "../providers/provider.js";

const fixtures = createSharedMobilityProviderFixtures("scooter-sharing", "scooter_standing");
const { makeResult, makeStation, makeVehicle } = fixtures;

describe("scooterSharingProvider.search", () => {
  it("GBFS + NRW + MOTIS stations deduplicated together", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const nrwStation = makeStation("nrw1", "de-nw-mobidrom-scooter");
    const motisStation = makeStation("mo1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({
      stations: [nrwStation],
      vehicles: [],
    });
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
    const nrwVehicle = makeVehicle("nrw-v1", "de-nw-mobidrom-scooter");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [gbfsVehicle] });
    vi.mocked(searchFelyx).mockResolvedValue([felyxVehicle]);
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({
      stations: [],
      vehicles: [nrwVehicle],
    });
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
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([gbfsStation]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;

    expect(results).toHaveLength(2);
  });

  it("individual source failures handled gracefully", async () => {
    vi.mocked(mapVehicleToResult).mockImplementation((v) => makeResult(v.id));
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockResolvedValue([makeVehicle("felyx-v1-solo", "felyx")]);
    vi.mocked(searchDeNwMobidromScooter).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("felyx-v1-solo");
  });

  it("all sources fail → returns empty array", async () => {
    vi.mocked(fetchGbfsData).mockRejectedValue(new Error("down"));
    vi.mocked(searchFelyx).mockRejectedValue(new Error("down"));
    vi.mocked(searchDeNwMobidromScooter).mockRejectedValue(new Error("down"));
    vi.mocked(fetchMotisRentals).mockRejectedValue(new Error("down"));
    vi.mocked(dedupStations).mockReturnValue([]);

    const results = (await scooterSharingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });

  it("fetches GBFS with scooter form factors and 'other' exclude", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    await scooterSharingProvider.search(makeBbox());

    expect(fetchGbfsData).toHaveBeenCalledWith(
      makeBbox(),
      expect.any(Set),
      expect.any(Object),
      "other",
    );
    const formFactors = vi.mocked(fetchGbfsData).mock.calls[0][1] as Set<string>;
    expect(formFactors.has("scooter_standing")).toBe(true);
    expect(formFactors.has("scooter_seated")).toBe(true);
    expect(formFactors.has("moped")).toBe(true);
  });

  it("MOTIS called with scooter form factors", async () => {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({ stations: [], vehicles: [] });
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
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(dedupStations).mockReturnValue([]);

    const bbox = makeBbox();
    await scooterSharingProvider.search(bbox);

    expect(searchDeNwMobidromScooter).toHaveBeenCalledWith(bbox, expect.any(Object));
  });
});

sharedMobilityProviderContract({
  name: "scooter sharing",
  provider: scooterSharingProvider,
  fixtures,
  formFactors: ["scooter_standing", "scooter_seated", "moped"],
  mapContextOptions: { systemIds: ["voioslo"], vehicleTypeIds: ["scooter"] },
  arrangeInventory({ station, vehicle }) {
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [vehicle] });
    vi.mocked(searchFelyx).mockResolvedValue([]);
    vi.mocked(searchDeNwMobidromScooter).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
  },
});
