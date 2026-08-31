import {
  createSharedMobilityProviderFixtures,
  createSharedMobilityBbox as makeBbox,
  sharedMobilityProviderContract,
} from "@openmapx/integration-framework/test/shared-mobility-provider";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { describe, expect, it, vi } from "vitest";

vi.mock("../providers/registry.js", () => ({
  searchRegionalClients: vi.fn(),
}));

vi.mock("../providers/merge-stations.js", () => ({
  mergeRegionalStations: vi.fn((items: unknown[]) => items),
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
import { mergeRegionalStations } from "../providers/merge-stations.js";
import { carSharingProvider } from "../providers/provider.js";
import { searchRegionalClients } from "../providers/registry.js";

const fixtures = createSharedMobilityProviderFixtures("car-sharing", "car");
const { makeResult, makeStation, makeVehicle } = fixtures;

describe("carSharingProvider.search", () => {
  it("regional stations merged first via mergeRegionalStations", async () => {
    vi.mocked(mapStationToResult).mockImplementation((s) => makeResult(s.id));
    const regional = [makeStation("reg1", "de-cambio"), makeStation("reg2", "stadtmobil")];
    vi.mocked(searchRegionalClients).mockResolvedValue(regional);
    vi.mocked(mergeRegionalStations).mockReturnValue(regional);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });

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
    expect(dedupCall[0].id).toBe("mo1");
    expect(dedupCall[1].id).toBe("gbfs1");
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
    const regStation = makeStation("reg1", "de-cambio");
    const gbfsStation = makeStation("gbfs1", "gbfs");
    const motisVehicle = makeVehicle("mo-v1", "motis");

    vi.mocked(searchRegionalClients).mockResolvedValue([regStation]);
    vi.mocked(mergeRegionalStations).mockReturnValue([regStation]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [gbfsStation], vehicles: [] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [motisVehicle] });

    const results = (await carSharingProvider.search(makeBbox())).data;

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

    const results = (await carSharingProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });
});

sharedMobilityProviderContract({
  name: "car sharing",
  provider: carSharingProvider,
  fixtures,
  formFactors: ["car"],
  mapContextOptions: { systemIds: ["bilkollektivet"], vehicleTypeIds: ["car"] },
  arrangeInventory({ station, vehicle }) {
    vi.mocked(searchRegionalClients).mockResolvedValue([]);
    vi.mocked(mergeRegionalStations).mockReturnValue([]);
    vi.mocked(fetchGbfsData).mockResolvedValue({ stations: [station], vehicles: [vehicle] });
    vi.mocked(fetchMotisRentals).mockResolvedValue({ stations: [], vehicles: [] });
  },
});
