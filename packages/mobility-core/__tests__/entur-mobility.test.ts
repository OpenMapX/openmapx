import type { SharedMobilityStation } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  TTL: {
    sharedMobility: {
      stations: 300,
    },
  },
  withCache: vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../src/gbfs-catalog.js", () => ({
  filterCatalogByBbox: vi.fn((entries: unknown[]) => entries),
  loadCatalog: vi.fn(),
  normalizeFormFactor: vi.fn((value: string | undefined) => {
    switch (value) {
      case "bicycle":
      case "cargo_bicycle":
      case "scooter_standing":
      case "scooter_seated":
      case "car":
      case "moped":
        return value;
      default:
        return "other";
    }
  }),
}));

import { buildEnturGeofencingMapContext, enrichEnturMobilityItems } from "../src/entur-mobility.js";
import { filterCatalogByBbox, loadCatalog } from "../src/gbfs-catalog.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetchJson(data: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => data,
    }),
  );
}

function makeStation(overrides?: Partial<SharedMobilityStation>): SharedMobilityStation {
  return {
    id: "station-1",
    nativeId: "native-station-1",
    systemId: "entur-system",
    name: "Existing Station",
    coordinates: [10.75, 60.75],
    availableVehicles: 3,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["gbfs/test"],
    ...overrides,
  };
}

const VOI_OSLO_CATALOG_ENTRY = {
  countryCode: "NO",
  location: "Oslo",
  name: "Voi Oslo",
  systemId: "voi-oslo",
  url: "https://example.com/voi-oslo",
  autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/voi-oslo/gbfs",
};

describe("buildEnturGeofencingMapContext", () => {
  it("clips returned geometry to the requested bbox", async () => {
    vi.mocked(loadCatalog).mockResolvedValue([VOI_OSLO_CATALOG_ENTRY]);
    mockFetchJson({
      data: {
        geofencingZones: [
          {
            systemId: "voi-oslo",
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
                    name: "No parking zone",
                    rules: [
                      {
                        vehicleTypeIds: ["scooter"],
                        rideStartAllowed: true,
                        rideEndAllowed: false,
                        rideThroughAllowed: true,
                        stationParking: false,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const bbox = { west: 10, south: 60, east: 11, north: 61 };
    const context = await buildEnturGeofencingMapContext(bbox, {
      systemIds: ["voi-oslo"],
      vehicleTypeIds: ["scooter"],
    });

    expect(context?.geojson.features).toHaveLength(1);
    const ring =
      context?.geojson.features[0].geometry.type === "Polygon"
        ? context.geojson.features[0].geometry.coordinates[0]
        : [];
    expect(ring).toHaveLength(5);
    for (const [lng, lat] of ring) {
      expect(lng).toBeGreaterThanOrEqual(bbox.west);
      expect(lng).toBeLessThanOrEqual(bbox.east);
      expect(lat).toBeGreaterThanOrEqual(bbox.south);
      expect(lat).toBeLessThanOrEqual(bbox.north);
    }
  });

  it("filters out zones for other vehicle types", async () => {
    vi.mocked(loadCatalog).mockResolvedValue([VOI_OSLO_CATALOG_ENTRY]);
    mockFetchJson({
      data: {
        geofencingZones: [
          {
            systemId: "voi-oslo",
            geojson: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: {
                    type: "Polygon",
                    coordinates: [
                      [
                        [10, 60],
                        [11, 60],
                        [11, 61],
                        [10, 61],
                        [10, 60],
                      ],
                    ],
                  },
                  properties: {
                    name: "Scooter only zone",
                    rules: [
                      {
                        vehicleTypeIds: ["scooter"],
                        rideStartAllowed: true,
                        rideEndAllowed: false,
                        rideThroughAllowed: true,
                        stationParking: false,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const context = await buildEnturGeofencingMapContext(
      { west: 10, south: 60, east: 11, north: 61 },
      {
        systemIds: ["voi-oslo"],
        vehicleTypeIds: ["car"],
      },
    );

    expect(context).toBeNull();
  });

  it("resolves Entur systems from the catalog when no explicit system selection is provided", async () => {
    const bbox = { west: 10, south: 60, east: 11, north: 61 };
    vi.mocked(loadCatalog).mockResolvedValue([
      {
        countryCode: "NO",
        location: "Oslo",
        name: "Oslo Bysykkel",
        systemId: "oslobysykkel",
        url: "https://example.com/oslo",
        autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
      },
      {
        countryCode: "CH",
        location: "Switzerland",
        name: "sharedmobility.ch",
        systemId: "sharedmobility.ch",
        url: "https://sharedmobility.ch",
        autoDiscoveryUrl: "https://sharedmobility.ch/gbfs.json",
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.variables.systemIds).toEqual(["oslobysykkel"]);
        return {
          ok: true,
          json: async () => ({
            data: {
              geofencingZones: [
                {
                  systemId: "oslobysykkel",
                  geojson: {
                    type: "FeatureCollection",
                    features: [
                      {
                        type: "Feature",
                        geometry: {
                          type: "Polygon",
                          coordinates: [
                            [
                              [10, 60],
                              [11, 60],
                              [11, 61],
                              [10, 61],
                              [10, 60],
                            ],
                          ],
                        },
                        properties: {
                          name: "No parking",
                          rules: [
                            {
                              vehicleTypeIds: ["bike"],
                              rideStartAllowed: true,
                              rideEndAllowed: false,
                              rideThroughAllowed: true,
                              stationParking: false,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        };
      }),
    );

    const context = await buildEnturGeofencingMapContext(bbox, { vehicleTypeIds: ["bike"] });

    expect(filterCatalogByBbox).toHaveBeenCalledWith(expect.any(Array), bbox);
    expect(context?.geojson.features[0].properties?.systemId).toBe("oslobysykkel");
  });

  it("returns null when explicit systemIds are not Entur-hosted", async () => {
    vi.mocked(loadCatalog).mockResolvedValue([
      {
        countryCode: "DE",
        location: "Aachen",
        name: "Velocity Aachen",
        systemId: "esel_ac",
        url: "https://example.com/esel-ac",
        autoDiscoveryUrl: "https://gbfs.example.de/esel_ac/gbfs.json",
      },
    ]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const context = await buildEnturGeofencingMapContext(
      { west: 6, south: 50, east: 7, north: 51 },
      { systemIds: ["esel_ac", "dott-aachen", "nextbike_an"] },
    );

    expect(context).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("enrichEnturMobilityItems", () => {
  it("merges Entur pricing into existing pricing without overwriting current details", async () => {
    vi.mocked(loadCatalog).mockResolvedValue([
      {
        countryCode: "NO",
        location: "Norway",
        name: "Entur test",
        systemId: "entur-system",
        url: "https://example.com/feed",
        autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/manifest.json",
      },
    ]);

    mockFetchJson({
      data: {
        stations: [
          {
            id: "native-station-1",
            address: null,
            postCode: null,
            region: null,
            rentalMethods: null,
            isVirtualStation: false,
            stationArea: null,
            rentalUris: null,
            pricingPlans: [
              {
                name: {
                  translation: [{ language: "en", value: "Entur unlock" }],
                },
                description: null,
                currency: "NOK",
                price: 10,
                perKmPricing: null,
                perMinPricing: null,
              },
            ],
            system: {
              id: "entur-system",
              url: "https://entur.example",
              purchaseUrl: null,
              name: {
                translation: [{ language: "en", value: "Entur Bikes" }],
              },
              operator: {
                name: {
                  translation: [{ language: "en", value: "Entur Operator" }],
                },
              },
              brandAssets: null,
              rentalApps: null,
            },
            vehicleTypesAvailable: [],
          },
        ],
        vehicles: [],
      },
    });

    const stations = [
      makeStation({
        pricingSummary: "1.50 EUR unlock",
        pricingDetails: [
          {
            name: "Existing unlock",
            currency: "EUR",
            flatRate: 1.5,
          },
        ],
      }),
    ];

    await enrichEnturMobilityItems(stations, []);

    expect(stations[0].pricingSummary).toBe("1.50 EUR unlock");
    expect(stations[0].pricingDetails).toEqual([
      {
        name: "Existing unlock",
        currency: "EUR",
        flatRate: 1.5,
      },
      {
        name: "Entur unlock",
        description: undefined,
        currency: "NOK",
        flatRate: 10,
        perKmRate: undefined,
        perHourRate: undefined,
      },
    ]);
  });
});
