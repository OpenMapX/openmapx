import { describe, expect, it, vi } from "vitest";
import type { CacheClient } from "../src/cache.js";
import { buildEnturGeofencingMapContext, enrichEnturMobilityItems } from "../src/entur-mobility.js";
import type { GbfsCatalogClient } from "../src/gbfs-catalog.js";
import type { MobilityHttpTransport } from "../src/json-transport.js";
import type { SharedMobilityStation } from "../src/types/shared-mobility.js";

function memoryCache(): CacheClient {
  const values = new Map<string, unknown>();
  return {
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
}
const catalog = {
  loadCatalog: async () => [
    {
      systemId: "entur-system",
      name: "Entur",
      countryCode: "NO",
      location: "Oslo",
      url: "https://api.entur.io/feed",
      autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/entur-system/gbfs",
    },
  ],
} as GbfsCatalogClient;
const a = { sourceId: "gbfs", name: "Original GBFS" };
const old = { sourceId: "entur-mobility", name: "Original Entur", attributionText: "Old notice" };
const next = { ...old, name: "New Entur", attributionText: "New notice" };
function station(): SharedMobilityStation {
  return {
    id: "gbfs/entur-system/station",
    systemId: "entur-system",
    nativeId: "station",
    name: "Station",
    coordinates: [10.5, 60.5],
    availableVehicles: 1,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["gbfs/entur-system"],
    contributors: [a],
  };
}
function transport(data: unknown) {
  return {
    userAgent: "test",
    fetchJson: vi.fn(async () => ({ data })),
    fetchText: async () => "",
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  } as MobilityHttpTransport;
}
const rawStation = {
  id: "station",
  address: "Entur street",
  postCode: null,
  region: null,
  rentalMethods: null,
  isVirtualStation: false,
  stationArea: null,
  rentalUris: null,
  pricingPlans: [],
  vehicleTypesAvailable: [],
  system: {
    id: "entur-system",
    url: "https://entur.example",
    purchaseUrl: null,
    name: { translation: [{ language: "en", value: "Entur Bikes" }] },
    operator: null,
    brandAssets: null,
    rentalApps: null,
  },
};

describe("Entur receipt acquisition", () => {
  it("credits only actual matched retained enrichment and preserves the cached receipt on repeated reads", async () => {
    const cache = memoryCache();
    const http = transport({ stations: [rawStation], vehicles: [] });
    const record = station();
    await enrichEnturMobilityItems([record], [], {
      cache,
      catalog,
      transport: http,
      resolveContributors: () => [old],
    });
    expect(record.address?.street).toBe("Entur street");
    expect(record.sources).toContain("entur-mobility");
    expect(record.contributors).toEqual([a, old]);
    await enrichEnturMobilityItems([record], [], {
      cache,
      catalog,
      transport: http,
      resolveContributors: () => [next],
    });
    expect(record.contributors).toEqual([a, old]);
    expect(http.fetchJson).toHaveBeenCalledTimes(1);
    const noMatch = station();
    noMatch.nativeId = "different";
    await enrichEnturMobilityItems([noMatch], [], {
      cache,
      catalog,
      transport: http,
      resolveContributors: () => [old],
    });
    expect(noMatch.contributors).toEqual([a]);
    const noChange = {
      ...structuredClone(record),
      sources: ["gbfs/entur-system"],
      contributors: [a],
    };
    await enrichEnturMobilityItems([noChange], [], {
      cache,
      catalog,
      transport: http,
      resolveContributors: () => [old],
    });
    expect(noChange.contributors).toEqual([a]);
  });
  it("keeps acquisition wording when the same cached geofence is clipped for a new bbox and registry generation", async () => {
    const cache = memoryCache();
    const http = transport({
      geofencingZones: [
        {
          systemId: "entur-system",
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [9, 59],
                      [12, 59],
                      [12, 62],
                      [9, 62],
                      [9, 59],
                    ],
                  ],
                },
                properties: {
                  name: "Zone",
                  rules: [
                    {
                      vehicleTypeIds: [],
                      rideStartAllowed: true,
                      rideEndAllowed: false,
                      rideThroughAllowed: true,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    const first = await buildEnturGeofencingMapContext(
      { west: 10, south: 60, east: 11, north: 61 },
      {
        cache,
        catalog,
        transport: http,
        systemIds: ["entur-system"],
        resolveContributors: () => [old],
      },
    );
    const second = await buildEnturGeofencingMapContext(
      { west: 10.2, south: 60.2, east: 10.8, north: 60.8 },
      {
        cache,
        catalog,
        transport: http,
        systemIds: ["entur-system"],
        resolveContributors: () => [next],
      },
    );
    expect(JSON.parse(String(first?.geojson.features[0].properties?._mapAttributions))).toEqual([
      old,
    ]);
    expect(JSON.parse(String(second?.geojson.features[0].properties?._mapAttributions))).toEqual([
      old,
    ]);
    expect(http.fetchJson).toHaveBeenCalledTimes(1);
  });
});

it("does not invent current registry receipts for a historical raw geofence cache entry", async () => {
  const cache = memoryCache();
  const http = transport({
    geofencingZones: [
      {
        systemId: "entur-system",
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [9, 59],
                    [12, 59],
                    [12, 62],
                    [9, 62],
                    [9, 59],
                  ],
                ],
              },
              properties: {
                rules: [
                  {
                    vehicleTypeIds: [],
                    rideStartAllowed: true,
                    rideEndAllowed: false,
                    rideThroughAllowed: true,
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  const bbox = { west: 10, south: 60, east: 11, north: 61 };
  const unknown = await buildEnturGeofencingMapContext(bbox, {
    cache,
    catalog,
    transport: http,
    systemIds: ["entur-system"],
  });
  const retained = await buildEnturGeofencingMapContext(
    { ...bbox, east: 10.8 },
    {
      cache,
      catalog,
      transport: http,
      systemIds: ["entur-system"],
      resolveContributors: () => [next],
    },
  );
  expect(unknown?.geojson.features[0].properties?._mapAttributions).toBeUndefined();
  expect(retained?.geojson.features[0].properties?._mapAttributions).toBeUndefined();
  expect(http.fetchJson).toHaveBeenCalledTimes(1);
});
