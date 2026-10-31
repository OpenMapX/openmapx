import type { BoundingBox, DataSourceMapContext, DataSourceMeta } from "@openmapx/core";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/mobility-core/shared-mobility";
import { createSharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheClient } from "../context";
import type { IntegrationDataSource } from "../manifest";
import { buildSharedMobilityMapContext } from "../shared-mobility/context";
import { createSharedMobilityProvider } from "../shared-mobility-provider-factory";

vi.mock("@openmapx/mobility-core/entur-mobility", () => ({
  enrichEnturMobilityItems: vi.fn(),
}));

vi.mock("../shared-mobility/context", () => ({
  buildSharedMobilityMapContext: vi.fn(),
}));

const BBOX: BoundingBox = { south: 48, west: 11, north: 49, east: 12 };
const FORM_FACTORS = new Set(["car"] as const);
const META: DataSourceMeta = {
  minZoom: 12,
  markerStyle: {
    variantColors: { available: "#fff" },
    defaultColor: "#fff",
    inactiveOpacity: 0.5,
    iconPath: "M0 0",
  },
  placeCategory: "Car Sharing Station",
  placeCategoryRaw: "car_sharing",
};

function station(id = "gbfs/provider/station-1"): SharedMobilityStation {
  return {
    id,
    name: "Station",
    coordinates: [11.5, 48.5],
    availableVehicles: 2,
    vehicleTypes: ["car"],
    isActive: true,
    sources: ["gbfs"],
  };
}

function vehicle(id = "gbfs/provider/vehicle-1"): SharedMobilityVehicle {
  return {
    id,
    coordinates: [11.5, 48.5],
    formFactor: "car",
    isReserved: false,
    isDisabled: false,
    sources: ["gbfs"],
  };
}

function cacheClient() {
  const values = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown, _ttl?: number) => {
    values.set(key, value);
  });
  const cache: CacheClient = {
    get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
    set,
    del: async (key) => {
      values.delete(key);
    },
    withCache: async (_key, _ttl, load) => load(new AbortController().signal),
  };
  return { cache, set };
}

function manifestSource(sourceId: string, name: string, url: string): IntegrationDataSource {
  return {
    sourceId,
    name,
    url,
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
      ],
    } as const,
    providerCountry: "DE",
    providerPrivacyUrl: `${url}/privacy`,
  };
}

function definition(
  loadInventory = vi.fn(async () => ({ stations: [station()], vehicles: [vehicle()] })),
  options: { cache?: CacheClient; dataSources?: IntegrationDataSource[] } = {},
) {
  const cache = options.cache ?? cacheClient().cache;
  const transport: MobilityHttpTransport = {
    userAgent: "OpenMapX/test",
    async fetchJson<T>() {
      return {} as T;
    },
    async fetchText() {
      return "";
    },
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  };
  const runtime = createSharedMobilityRuntime({ cache, transport });
  return createSharedMobilityProvider({
    id: "car-sharing",
    meta: META,
    formFactors: FORM_FACTORS,
    searchCacheTtl: 300,
    detailCacheTtl: 300,
    mapContextCacheTtl: 600,
    detailStore: { ttlSeconds: 900, maxL1Items: 3_000 },
    cache,
    dataSources: options.dataSources ?? [],
    runtime,
    loadInventory,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enrichEnturMobilityItems).mockResolvedValue(undefined);
  vi.mocked(buildSharedMobilityMapContext).mockResolvedValue(null);
});

describe("createSharedMobilityProvider", () => {
  it("publishes provider policy and credits only contributing manifest sources", async () => {
    const { cache, set } = cacheClient();
    const provider = definition(undefined, {
      cache,
      dataSources: [
        manifestSource("gbfs", "GBFS", "https://example.com"),
        manifestSource("unused", "Unused", "https://unused.example"),
      ],
    });

    expect(provider).toMatchObject({
      id: "car-sharing",
      meta: META,
      searchCacheTtl: 300,
      detailCacheTtl: 300,
      mapContextCacheTtl: 600,
    });
    await expect(provider.getFilters()).resolves.toEqual([]);

    const result = await provider.search(BBOX);

    expect(result.data.map((item) => item.id)).toEqual([
      "s:gbfs/provider/station-1",
      "v:gbfs/provider/vehicle-1",
    ]);
    expect(result.attributions.map((item) => item.sourceId)).toEqual(["gbfs"]);
    expect(result.freshness.hasRealtimeData).toBe(true);
    expect(set).toHaveBeenCalledWith(
      "shared-mobility-detail:v2:gbfs%2Fprovider",
      expect.any(Object),
      expect.any(Number),
    );
    expect(set.mock.calls[0]?.[2]).toBeGreaterThan(0);
    expect(set.mock.calls[0]?.[2]).toBeLessThanOrEqual(900);
  });

  it("returns mapped inventory when optional enrichment fails", async () => {
    vi.mocked(enrichEnturMobilityItems).mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = definition();

    const result = await shared.search(BBOX);

    expect(result.data).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("[car-sharing] Entur enrichment failed", expect.any(Error));
  });

  it("maps cached station and vehicle details and enriches each by kind", async () => {
    const shared = definition(undefined, {
      dataSources: [manifestSource("gbfs", "GBFS", "https://example.com")],
    });
    await shared.search(BBOX);
    vi.mocked(enrichEnturMobilityItems).mockClear();

    const stationDetail = await shared.getDetail("s:gbfs/provider/station-1");
    const vehicleDetail = await shared.getDetail("v:gbfs/provider/vehicle-1");
    const missingDetail = await shared.getDetail("missing");

    expect(stationDetail.data?.id).toBe("s:gbfs/provider/station-1");
    expect(vehicleDetail.data?.id).toBe("v:gbfs/provider/vehicle-1");
    expect(missingDetail.data).toBeNull();
    expect(stationDetail.attributions.map((item) => item.sourceId)).toEqual(["gbfs"]);
    expect(enrichEnturMobilityItems).toHaveBeenNthCalledWith(
      1,
      [expect.any(Object)],
      [],
      expect.objectContaining({ transport: expect.any(Object), scope: "detail" }),
    );
    expect(enrichEnturMobilityItems).toHaveBeenNthCalledWith(
      2,
      [],
      [expect.any(Object)],
      expect.objectContaining({ transport: expect.any(Object), scope: "detail" }),
    );
  });

  it("maps a cached station without published availability as a station", async () => {
    const { availableVehicles: _available, isActive: _active, ...staticStation } = station();
    const shared = definition(
      vi.fn(async () => ({ stations: [{ ...staticStation, capacity: 3 }], vehicles: [] })),
    );
    await shared.search(BBOX);
    vi.mocked(enrichEnturMobilityItems).mockClear();

    const detail = await shared.getDetail("s:gbfs/provider/station-1");

    expect(detail.data?.id).toBe("s:gbfs/provider/station-1");
    expect(enrichEnturMobilityItems).toHaveBeenCalledWith(
      [expect.objectContaining({ capacity: 3 })],
      [],
      expect.objectContaining({ scope: "detail" }),
    );
  });

  it("delegates map context selection and marks it as static", async () => {
    const context: DataSourceMapContext = {
      geojson: { type: "FeatureCollection", features: [] },
    };
    vi.mocked(buildSharedMobilityMapContext).mockResolvedValue(context);
    const shared = definition();
    const options = { providerIds: ["provider"] };

    const result = await shared.getMapContext?.(BBOX, {}, options);

    expect(buildSharedMobilityMapContext).toHaveBeenCalledWith(
      BBOX,
      FORM_FACTORS,
      expect.any(Object),
      options,
      expect.any(Function),
    );
    expect(result?.data).toBe(context);
    expect(result?.freshness.hasRealtimeData).toBe(false);
  });

  it("keeps an earlier provider generation bound to its own inventory, cache, and sources", async () => {
    const firstCache = cacheClient();
    const secondCache = cacheClient();
    const firstStation = station("first/station");
    firstStation.sources = ["first"];
    const secondStation = station("second/station");
    secondStation.sources = ["second"];
    const first = definition(
      vi.fn(async () => ({ stations: [firstStation], vehicles: [] })),
      {
        cache: firstCache.cache,
        dataSources: [manifestSource("first", "First", "https://first.example")],
      },
    );
    const second = definition(
      vi.fn(async () => ({ stations: [secondStation], vehicles: [] })),
      {
        cache: secondCache.cache,
        dataSources: [manifestSource("second", "Second", "https://second.example")],
      },
    );

    const secondResult = await second.search(BBOX);
    const firstResult = await first.search(BBOX);

    expect(firstResult.data.map((item) => item.id)).toEqual(["s:first/station"]);
    expect(firstResult.attributions.map((item) => item.sourceId)).toEqual(["first"]);
    expect(secondResult.data.map((item) => item.id)).toEqual(["s:second/station"]);
    expect(secondResult.attributions.map((item) => item.sourceId)).toEqual(["second"]);
    expect(firstCache.set).toHaveBeenCalledWith(
      "shared-mobility-detail:v2:first",
      expect.any(Object),
      expect.any(Number),
    );
    expect(secondCache.set).toHaveBeenCalledWith(
      "shared-mobility-detail:v2:second",
      expect.any(Object),
      expect.any(Number),
    );
    for (const write of [firstCache.set, secondCache.set]) {
      expect(write.mock.calls[0]?.[2]).toBeGreaterThan(0);
      expect(write.mock.calls[0]?.[2]).toBeLessThanOrEqual(900);
    }
  });
});

it("captures secondary inventory sources for both search records and cached details", async () => {
  const item = station();
  item.sources = ["transitous", "gbfs"];
  const shared = definition(
    vi.fn(async () => ({ stations: [item], vehicles: [] })),
    {
      dataSources: [
        manifestSource("gbfs", "GBFS", "https://gbfs.example"),
        manifestSource("transitous", "Transitous", "https://transitous.example"),
        manifestSource("unused", "Unused", "https://unused.example"),
      ],
    },
  );
  const response = await shared.search(BBOX);
  expect(response.data[0].contributors?.map((a) => a.sourceId)).toEqual(["transitous", "gbfs"]);
  expect(response.attributions.map((a) => a.sourceId)).toEqual(["transitous", "gbfs"]);
  const detail = await shared.getDetail(response.data[0].id);
  expect(detail.data?.contributors).toEqual(response.data[0].contributors);
});

it("credits only the map context feature receipts, including no credit for empty context", async () => {
  const receipt = { sourceId: "entur-mobility", name: "Entur", attributionText: "Context notice" };
  vi.mocked(buildSharedMobilityMapContext).mockResolvedValue({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: { _mapAttributions: JSON.stringify([receipt]) },
        },
      ],
    },
  });
  const shared = definition(undefined, {
    dataSources: [manifestSource("unused", "Unused", "https://unused.example")],
  });
  expect((await shared.getMapContext?.(BBOX))?.attributions).toEqual([receipt]);
  vi.mocked(buildSharedMobilityMapContext).mockResolvedValue(null);
  expect((await shared.getMapContext?.(BBOX))?.attributions).toEqual([]);
});

it("keeps cached receipt wording across provider metadata generations", async () => {
  const { cache } = cacheClient();
  const first = definition(undefined, {
    cache,
    dataSources: [manifestSource("gbfs", "Original GBFS credit", "https://original.example")],
  });
  await first.search(BBOX);
  const second = definition(undefined, {
    cache,
    dataSources: [manifestSource("gbfs", "New unrelated wording", "https://new.example")],
  });
  const detail = await second.getDetail("s:gbfs/provider/station-1");
  expect(detail.data?.contributors?.map((a) => a.name)).toEqual(["Original GBFS credit"]);
  expect(detail.attributions.map((a) => a.name)).toEqual(["Original GBFS credit"]);
});

it("treats explicit empty inventory receipts as authoritative", async () => {
  const item = station();
  item.contributors = [];
  const shared = definition(
    vi.fn(async () => ({ stations: [item], vehicles: [] })),
    { dataSources: [manifestSource("gbfs", "GBFS", "https://gbfs.example")] },
  );
  const response = await shared.search(BBOX);
  expect(response.data[0].contributors).toEqual([]);
  expect(response.attributions).toEqual([]);
});

it("adds only newly supplied detail enrichment sources to cached receipts", async () => {
  const shared = definition(undefined, {
    dataSources: [
      manifestSource("gbfs", "GBFS", "https://gbfs.example"),
      manifestSource("entur-mobility", "Entur", "https://entur.example"),
    ],
  });
  await shared.search(BBOX);
  vi.mocked(enrichEnturMobilityItems).mockImplementationOnce(
    async (stations, _vehicles, options) => {
      stations[0].address = { street: "Newly acquired field" };
      stations[0].contributors = [
        ...(stations[0].contributors ?? []),
        ...(options.resolveContributors?.(["entur-mobility"]) ?? []),
      ];
      stations[0].sources = [...stations[0].sources, "entur-mobility"];
    },
  );
  const response = await shared.getDetail("s:gbfs/provider/station-1");
  expect(response.data?.contributors?.map((a) => a.sourceId)).toEqual(["gbfs", "entur-mobility"]);
  const retained = await shared.getDetail("s:gbfs/provider/station-1");
  expect(retained.data?.contributors).toEqual(response.data?.contributors);
});
