import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import type { GbfsCatalogClient } from "@openmapx/mobility-core/gbfs-catalog";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { expect, it, vi } from "vitest";
import type { CacheClient } from "../context.js";
import { createSharedMobilityProvider } from "../shared-mobility-provider-factory.js";

it("persists actual Entur enrichment receipts through factory search and repeated cached details", async () => {
  const values = new Map<string, unknown>();
  const cache: CacheClient = {
    get: async <T>(key: string) => (values.get(key) as T) ?? null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    del: async (key) => {
      values.delete(key);
    },
    withCache: async function <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) {
      const retained = await this.get<T>(key);
      if (retained !== null) return retained;
      const data = await load(new AbortController().signal);
      await this.set(key, data);
      return data;
    },
  };
  const catalog = {
    loadCatalog: async () => [
      {
        systemId: "entur-system",
        name: "System",
        countryCode: "NO",
        location: "Oslo",
        url: "https://api.entur.io/feed",
        autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/entur-system/gbfs",
      },
    ],
  } as GbfsCatalogClient;
  const http = {
    userAgent: "test",
    fetchJson: vi.fn(async () => ({
      data: {
        stations: [
          {
            id: "native",
            address: "Actual Entur address",
            system: {
              id: "entur-system",
              name: { translation: [{ language: "en", value: "Entur" }] },
              operator: null,
              brandAssets: null,
              rentalApps: null,
            },
          },
        ],
        vehicles: [],
      },
    })),
    fetchText: async () => "",
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  } as MobilityHttpTransport;
  const runtime = {
    enrichEnturMobilityItems: (stations, vehicles, scope, resolveContributors) =>
      enrichEnturMobilityItems(stations, vehicles, {
        cache,
        catalog,
        transport: http,
        scope,
        resolveContributors,
      }),
  } as SharedMobilityRuntime;
  const original = { sourceId: "gbfs", name: "GBFS", attributionText: "Original GBFS notice" };
  const item: SharedMobilityStation = {
    id: "gbfs/entur-system/native",
    nativeId: "native",
    systemId: "entur-system",
    name: "Station",
    coordinates: [10.5, 60.5],
    availableVehicles: 2,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["gbfs/entur-system"],
    contributors: [original],
  };
  const provider = createSharedMobilityProvider({
    id: "bike-sharing",
    meta: {
      minZoom: 12,
      placeCategory: "Bike",
      placeCategoryRaw: "bicycle",
      markerStyle: {
        variantColors: {},
        defaultColor: "red",
        inactiveOpacity: 0.5,
        iconPath: "M0 0",
      },
    },
    formFactors: new Set(["bicycle"]),
    searchCacheTtl: 60,
    detailCacheTtl: 60,
    mapContextCacheTtl: 60,
    detailStore: { ttlSeconds: 600, maxL1Items: 100 },
    cache,
    runtime,
    dataSources: [
      {
        sourceId: "entur-mobility",
        name: "Entur",
        url: "https://entur.example",
        license: "CC0-1.0",
        attribution: "Required Entur notice",
        providerCountry: "NO",
        providerPrivacyUrl: "https://entur.example/privacy",
      },
    ],
    loadInventory: async () => ({ stations: [item], vehicles: [] }),
  });
  const response = await provider.search({ west: 10, south: 60, east: 11, north: 61 });
  expect(response.data[0].contributors?.map((a) => a.sourceId)).toEqual(["gbfs", "entur-mobility"]);
  const first = await provider.getDetail(response.data[0].id);
  const second = await provider.getDetail(response.data[0].id);
  expect(first.data?.contributors).toEqual(response.data[0].contributors);
  expect(second.data?.contributors).toEqual(first.data?.contributors);
  expect(http.fetchJson).toHaveBeenCalledTimes(2);
});
