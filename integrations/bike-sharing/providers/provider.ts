/**
 * Bike Sharing data source provider.
 * Combines CityBikes API + GBFS bicycle feeds + Nextbike + Donkey Republic.
 */

import type { BoundingBox, DataSourceMeta } from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { createSharedMobilityProvider } from "@openmapx/integration-framework/shared-mobility-provider";
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import type { searchCityBikes } from "./citybikes-client.js";
import type { createDbBikeClient } from "./db-bike-client.js";
import type { searchDonkey } from "./donkey-client.js";
import type { searchNextbike } from "./nextbike-client.js";

const BIKE_FORM_FACTORS = new Set<VehicleFormFactor>(["bicycle", "cargo_bicycle"]);

const META: DataSourceMeta = {
  minZoom: 12,
  markerStyle: {
    type: "icon",
    variantColors: {
      available: "#4CAF50",
      full: "#FF9800",
      empty: "#F44336",
      inactive: "#9E9E9E",
    },
    defaultColor: "#4CAF50",
    inactiveOpacity: 0.5,
    iconPath:
      "M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2M5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5S3.07 13.5 5 13.5s3.5 1.57 3.5 3.5S6.93 20.5 5 20.5m5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V11c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 10.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 16v5h2v-6.2zm9.2 1.5c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5",
  },
  showResultsList: true,
  placeCategory: "Bike Sharing Station",
  placeCategoryRaw: "bicycle_rental",
  osmFilters: CATEGORY_FILTERS.bicycle_rental,
};

export interface BikeSharingProviderOptions {
  runtime: SharedMobilityRuntime;
  dataSources: IntegrationDataSource[];
  searchCityBikes: typeof searchCityBikes;
  searchDbBikes: ReturnType<typeof createDbBikeClient>;
  searchDonkey: typeof searchDonkey;
  searchNextbike: typeof searchNextbike;
}

export function createBikeSharingProvider(options: BikeSharingProviderOptions) {
  const loadBikeInventory = (bbox: BoundingBox) =>
    options.runtime.orchestrate(bbox, {
      category: "bike",
      motisFormFactors: ["bicycle", "cargo_bicycle"],
      adapters: [
        {
          id: "nextbike",
          kind: "fallback",
          fetch: async (bounds) => ({
            stations: await options.searchNextbike(bounds, options.runtime.cache),
            vehicles: [],
          }),
        },
        {
          id: "citybikes",
          kind: "fallback",
          fetch: async (bounds) => ({
            stations: await options.searchCityBikes(bounds, options.runtime.cache),
            vehicles: [],
          }),
        },
        {
          id: "donkey",
          kind: "fallback",
          fetch: async (bounds) => ({ stations: await options.searchDonkey(bounds), vehicles: [] }),
        },
        {
          id: "direct-gbfs",
          kind: "fallback",
          fetch: (bounds) => options.runtime.fetchGbfsData(bounds, BIKE_FORM_FACTORS),
        },
        {
          id: "swiss-gbfs",
          kind: "fallback",
          fetch: (bounds) =>
            options.runtime.fetchSwissSharedMobilityDataForBbox(bounds, BIKE_FORM_FACTORS),
        },
        {
          id: "db-bike",
          kind: "proprietary",
          fetch: options.searchDbBikes,
        },
      ],
    });

  return createSharedMobilityProvider({
    id: "bike-sharing",
    meta: META,
    formFactors: BIKE_FORM_FACTORS,
    searchCacheTtl: 120,
    detailCacheTtl: 120,
    mapContextCacheTtl: 300,
    detailStore: { ttlSeconds: 600, maxL1Items: 5_000 },
    cache: options.runtime.cache,
    dataSources: options.dataSources,
    runtime: options.runtime,
    loadInventory: loadBikeInventory,
  });
}
