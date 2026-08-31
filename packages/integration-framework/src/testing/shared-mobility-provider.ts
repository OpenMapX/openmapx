import type { BoundingBox, DataSourceMapContextSelection, DataSourceResult } from "@openmapx/core";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import { fetchSwissSharedMobilityDataForBbox } from "@openmapx/mobility-core/gbfs-provider-base";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
} from "@openmapx/mobility-core/shared-mobility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilityDataSourceProvider } from "../contracts/mobility-data-source-provider.js";
import { buildSharedMobilityMapContext } from "../shared-mobility/context.js";

const mapperMocks = vi.hoisted(() => ({
  mapStationToResult: vi.fn(),
  mapStationToDetail: vi.fn(),
  mapVehicleToResult: vi.fn(),
  mapVehicleToDetail: vi.fn(),
  stripMobilityKindPrefix: (id: string) =>
    id.startsWith("s:") || id.startsWith("v:") ? id.slice(2) : id,
}));

export const { mapStationToResult, mapVehicleToResult } = mapperMocks;

vi.mock("@openmapx/mobility-core/gbfs-provider-base", () => ({
  fetchGbfsData: vi.fn(),
  fetchSwissSharedMobilityDataForBbox: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/entur-mobility", () => ({
  enrichEnturMobilityItems: vi.fn(),
}));

vi.mock("../shared-mobility/context.js", () => ({
  buildSharedMobilityMapContext: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/motis-rentals", () => ({
  fetchMotisRentals: vi.fn(),
}));

vi.mock("@openmapx/mobility-core/dedup", () => ({
  dedupStations: vi.fn(),
  dedupVehicles: vi.fn(),
}));

vi.mock("../shared-mobility/mapper.js", () => mapperMocks);

import { dedupStations, dedupVehicles } from "@openmapx/mobility-core/dedup";

export interface SharedMobilityProviderFixtures {
  makeStation(id: string, source: string): SharedMobilityStation;
  makeVehicle(id: string, source: string): SharedMobilityVehicle;
  makeResult(id: string): DataSourceResult;
}

export function createSharedMobilityBbox(): BoundingBox {
  return { south: 48, west: 11, north: 49, east: 12 };
}

export function createSharedMobilityProviderFixtures(
  providerId: string,
  formFactor: VehicleFormFactor,
): SharedMobilityProviderFixtures {
  return {
    makeStation(id, source) {
      return {
        id,
        name: `Station ${id}`,
        coordinates: [11.5, 48.5],
        availableVehicles: 3,
        vehicleTypes: [formFactor],
        isActive: true,
        sources: [source],
      };
    },
    makeVehicle(id, source) {
      return {
        id,
        coordinates: [11.5, 48.5],
        formFactor,
        isReserved: false,
        isDisabled: false,
        sources: [source],
      };
    },
    makeResult(id) {
      return {
        id,
        name: `Item ${id}`,
        coordinates: [11.5, 48.5],
        source: providerId,
        variant: "available",
        status: "available",
      };
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(dedupStations).mockImplementation((items) => items);
  vi.mocked(dedupVehicles).mockImplementation((items) => items);
  vi.mocked(fetchSwissSharedMobilityDataForBbox).mockResolvedValue({
    stations: [],
    vehicles: [],
  });
  vi.mocked(enrichEnturMobilityItems).mockResolvedValue(undefined);
  vi.mocked(buildSharedMobilityMapContext).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface SharedMobilityInventoryFixture {
  station: SharedMobilityStation;
  vehicle: SharedMobilityVehicle;
}

export interface SharedMobilityProviderContractOptions {
  name: string;
  provider: MobilityDataSourceProvider;
  fixtures: SharedMobilityProviderFixtures;
  formFactors: readonly VehicleFormFactor[];
  mapContextOptions: DataSourceMapContextSelection;
  arrangeInventory(fixture: SharedMobilityInventoryFixture): void | Promise<void>;
}

export function sharedMobilityProviderContract(
  options: SharedMobilityProviderContractOptions,
): void {
  describe(`${options.name} shared-mobility provider contract`, () => {
    it("enriches and maps the assembled inventory", async () => {
      const station = options.fixtures.makeStation("contract-station", "contract");
      const vehicle = options.fixtures.makeVehicle("contract-vehicle", "contract");
      vi.mocked(mapStationToResult).mockImplementation((item) =>
        options.fixtures.makeResult(item.id),
      );
      vi.mocked(mapVehicleToResult).mockImplementation((item) =>
        options.fixtures.makeResult(item.id),
      );
      await options.arrangeInventory({ station, vehicle });

      const result = await options.provider.search(createSharedMobilityBbox());

      expect(enrichEnturMobilityItems).toHaveBeenCalledWith([station], [vehicle], {
        transport: expect.any(Object),
        scope: "map",
      });
      expect(mapStationToResult).toHaveBeenCalledWith(station);
      expect(mapVehicleToResult).toHaveBeenCalledWith(vehicle);
      expect(result.data.map((item) => item.id)).toEqual([station.id, vehicle.id]);
    });

    it("delegates map context with its declared form factors", async () => {
      const bbox = createSharedMobilityBbox();

      await options.provider.getMapContext?.(bbox, {}, options.mapContextOptions);

      expect(buildSharedMobilityMapContext).toHaveBeenCalledWith(
        bbox,
        new Set(options.formFactors),
        expect.any(Object),
        options.mapContextOptions,
      );
    });
  });
}
