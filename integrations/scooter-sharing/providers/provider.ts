/**
 * Scooter Sharing data source provider.
 * Combines GBFS scooter feeds + Felyx + NRW Mobidrom + MOTIS/Transitous.
 * Handles both free-floating vehicles and docked stations.
 */

import type { BoundingBox, DataSourceMeta } from "@openmapx/core";
import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { createSharedMobilityProvider } from "@openmapx/integration-framework/shared-mobility-provider";
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import type { createDeNwMobidromScooterClient } from "./de-nw-mobidrom-scooter-client.js";
import type { searchFelyx } from "./felyx-client.js";

const META: DataSourceMeta = {
  minZoom: 13,
  markerStyle: {
    type: "circle",
    variantColors: {
      available: "#7C4DFF",
      high_battery: "#4CAF50",
      medium_battery: "#FF9800",
      low_battery: "#F44336",
      reserved: "#9E9E9E",
      disabled: "#9E9E9E",
      full: "#7C4DFF",
      empty: "#BDBDBD",
      inactive: "#9E9E9E",
    },
    defaultColor: "#7C4DFF",
    inactiveOpacity: 0.5,
    iconPath:
      "M7.82 16H15v-1c0-2.21 1.79-4 4-4h.74l-1.22-3H15V6c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H5.5c-.66 0-1.21.42-1.42 1.01L2 16v2c0 1.1.9 2 2 2h1c0 1.66 1.34 3 3 3s3-1.34 3-3h2c0 1.66 1.34 3 3 3s3-1.34 3-3h1c1.1 0 2-.9 2-2v-2H7.82zM8 20c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m8 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1",
  },
  showResultsList: true,
  placeCategory: "E-Scooter",
  placeCategoryRaw: "scooter_rental",
};

const SCOOTER_FORM_FACTORS = new Set<VehicleFormFactor>([
  "scooter_standing",
  "scooter_seated",
  "moped",
]);

export function createScooterSharingProvider(options: {
  runtime: SharedMobilityRuntime;
  dataSources: IntegrationDataSource[];
  searchDeNwMobidromScooter: ReturnType<typeof createDeNwMobidromScooterClient>;
  searchFelyx: typeof searchFelyx;
}) {
  const loadScooterInventory = (bbox: BoundingBox) =>
    options.runtime.orchestrate(bbox, {
      category: "scooter",
      motisFormFactors: ["scooter_standing", "scooter_seated", "moped"],
      adapters: [
        {
          id: "direct-gbfs",
          kind: "fallback",
          fetch: (bounds) => options.runtime.fetchGbfsData(bounds, SCOOTER_FORM_FACTORS, "other"),
        },
        {
          id: "swiss-gbfs",
          kind: "fallback",
          fetch: (bounds) =>
            options.runtime.fetchSwissSharedMobilityDataForBbox(
              bounds,
              SCOOTER_FORM_FACTORS,
              "other",
            ),
        },
        {
          id: "felyx",
          kind: "proprietary",
          fetch: async (bounds) => ({
            stations: [],
            vehicles: await options.searchFelyx(bounds),
          }),
        },
        {
          id: "nrw-mobidrom",
          kind: "proprietary",
          fetch: options.searchDeNwMobidromScooter,
        },
      ],
    });

  return createSharedMobilityProvider({
    id: "scooter-sharing",
    meta: META,
    formFactors: SCOOTER_FORM_FACTORS,
    searchCacheTtl: 120,
    detailCacheTtl: 120,
    mapContextCacheTtl: 300,
    detailStore: { ttlSeconds: 600, maxL1Items: 5_000 },
    cache: options.runtime.cache,
    dataSources: options.dataSources,
    runtime: options.runtime,
    loadInventory: loadScooterInventory,
  });
}
