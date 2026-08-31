/**
 * Scooter Sharing data source provider.
 * Combines GBFS scooter feeds + Felyx + NRW Mobidrom + MOTIS/Transitous.
 * Handles both free-floating vehicles and docked stations.
 */

import type { BoundingBox, DataSourceMeta } from "@openmapx/core";
import { createSharedMobilityProvider } from "@openmapx/integration-framework/shared-mobility-provider";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/mobility-core/gbfs-provider-base";
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import { orchestrateSharedMobility } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import { searchDeNwMobidromScooter } from "./de-nw-mobidrom-scooter-client.js";
import { searchFelyx } from "./felyx-client.js";

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

async function loadScooterInventory(bbox: BoundingBox) {
  return orchestrateSharedMobility(bbox, {
    category: "scooter",
    formFactors: SCOOTER_FORM_FACTORS,
    motisFormFactors: ["scooter_standing", "scooter_seated", "moped"],
    adapters: [
      {
        id: "direct-gbfs",
        kind: "fallback",
        fetch: (bounds) => fetchGbfsData(bounds, SCOOTER_FORM_FACTORS, "other"),
      },
      {
        id: "swiss-gbfs",
        kind: "fallback",
        fetch: (bounds) =>
          fetchSwissSharedMobilityDataForBbox(bounds, SCOOTER_FORM_FACTORS, "other"),
      },
      {
        id: "felyx",
        kind: "proprietary",
        fetch: async (bounds) => ({ stations: [], vehicles: await searchFelyx(bounds) }),
      },
      {
        id: "nrw-mobidrom",
        kind: "proprietary",
        fetch: searchDeNwMobidromScooter,
      },
    ],
  });
}

export const {
  provider: scooterSharingProvider,
  setDetailCache,
  setManifestDataSources,
} = createSharedMobilityProvider({
  id: "scooter-sharing",
  meta: META,
  formFactors: SCOOTER_FORM_FACTORS,
  searchCacheTtl: 120,
  detailCacheTtl: 120,
  mapContextCacheTtl: 300,
  detailStore: { ttlSeconds: 600, maxL1Items: 5_000 },
  loadInventory: loadScooterInventory,
});
