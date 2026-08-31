/**
 * Car Sharing data source provider.
 * Combines GBFS car feeds + registered regional car-sharing clients.
 */

import type { BoundingBox, DataSourceMeta } from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import { createSharedMobilityProvider } from "@openmapx/integration-framework";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/mobility-core/gbfs-provider-base";
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import { orchestrateSharedMobility } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import { mergeRegionalStations } from "./merge-stations.js";
import { searchRegionalClients } from "./registry.js";

const META: DataSourceMeta = {
  minZoom: 12,
  markerStyle: {
    type: "icon",
    variantColors: {
      available: "#2196F3",
      full: "#FF9800",
      empty: "#F44336",
      inactive: "#9E9E9E",
    },
    defaultColor: "#2196F3",
    inactiveOpacity: 0.5,
    iconPath:
      "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16m11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5M5 11l1.5-4.5h11L19 11z",
  },
  showResultsList: true,
  placeCategory: "Car Sharing Station",
  placeCategoryRaw: "car_sharing",
  osmFilters: CATEGORY_FILTERS.car_sharing,
};

const CAR_FORM_FACTORS = new Set<VehicleFormFactor>(["car"]);

async function loadCarInventory(bbox: BoundingBox) {
  return orchestrateSharedMobility(bbox, {
    category: "car",
    formFactors: CAR_FORM_FACTORS,
    motisFormFactors: ["car"],
    adapters: [
      {
        id: "direct-gbfs",
        kind: "fallback",
        fetch: (bounds) => fetchGbfsData(bounds, CAR_FORM_FACTORS),
      },
      {
        id: "swiss-gbfs",
        kind: "fallback",
        fetch: (bounds) => fetchSwissSharedMobilityDataForBbox(bounds, CAR_FORM_FACTORS),
      },
      {
        id: "regional",
        kind: "proprietary",
        fetch: async (bounds) => ({
          stations: mergeRegionalStations(await searchRegionalClients(bounds)),
          vehicles: [],
        }),
      },
    ],
  });
}

export const {
  provider: carSharingProvider,
  setDetailCache,
  setManifestDataSources,
} = createSharedMobilityProvider({
  id: "car-sharing",
  meta: META,
  formFactors: CAR_FORM_FACTORS,
  searchCacheTtl: 300,
  detailCacheTtl: 300,
  mapContextCacheTtl: 300,
  detailStore: { ttlSeconds: 900, maxL1Items: 3_000 },
  loadInventory: loadCarInventory,
});
