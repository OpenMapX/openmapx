import type { BoundingBox, DataSourceMapContext, DataSourceMeta } from "@openmapx/core";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/mobility-core/shared-mobility";
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
  const set = vi.fn(async (key: string, value: unknown) => {
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
    license: "CC0-1.0",
    providerCountry: "DE",
    providerPrivacyUrl: `${url}/privacy`,
  };
}

function definition(
  loadInventory = vi.fn(async () => ({ stations: [station()], vehicles: [vehicle()] })),
) {
  return createSharedMobilityProvider({
    id: "car-sharing",
    meta: META,
    formFactors: FORM_FACTORS,
    searchCacheTtl: 300,
    detailCacheTtl: 300,
    mapContextCacheTtl: 600,
    detailStore: { ttlSeconds: 900, maxL1Items: 3_000 },
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
    const shared = definition();
    const { cache, set } = cacheClient();
    shared.setDetailCache(cache);
    shared.setManifestDataSources([
      manifestSource("gbfs", "GBFS", "https://example.com"),
      manifestSource("unused", "Unused", "https://unused.example"),
    ]);

    expect(shared.provider).toMatchObject({
      id: "car-sharing",
      meta: META,
      searchCacheTtl: 300,
      detailCacheTtl: 300,
      mapContextCacheTtl: 600,
    });
    await expect(shared.provider.getFilters()).resolves.toEqual([]);

    const result = await shared.provider.search(BBOX);

    expect(result.data.map((item) => item.id)).toEqual([
      "s:gbfs/provider/station-1",
      "v:gbfs/provider/vehicle-1",
    ]);
    expect(result.attributions.map((item) => item.sourceId)).toEqual(["gbfs"]);
    expect(result.freshness.hasRealtimeData).toBe(true);
    expect(set).toHaveBeenCalledWith(
      "shared-mobility-detail:v1:gbfs%2Fprovider",
      expect.any(Object),
      900,
    );
  });

  it("returns mapped inventory when optional enrichment fails", async () => {
    vi.mocked(enrichEnturMobilityItems).mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = definition();

    const result = await shared.provider.search(BBOX);

    expect(result.data).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("[car-sharing] Entur enrichment failed", expect.any(Error));
  });

  it("maps cached station and vehicle details and enriches each by kind", async () => {
    const shared = definition();
    shared.setManifestDataSources([manifestSource("gbfs", "GBFS", "https://example.com")]);
    await shared.provider.search(BBOX);
    vi.mocked(enrichEnturMobilityItems).mockClear();

    const stationDetail = await shared.provider.getDetail("s:gbfs/provider/station-1");
    const vehicleDetail = await shared.provider.getDetail("v:gbfs/provider/vehicle-1");
    const missingDetail = await shared.provider.getDetail("missing");

    expect(stationDetail.data?.id).toBe("s:gbfs/provider/station-1");
    expect(vehicleDetail.data?.id).toBe("v:gbfs/provider/vehicle-1");
    expect(missingDetail.data).toBeNull();
    expect(stationDetail.attributions.map((item) => item.sourceId)).toEqual(["gbfs"]);
    expect(enrichEnturMobilityItems).toHaveBeenNthCalledWith(1, [expect.any(Object)], [], {
      transport: expect.any(Object),
      scope: "detail",
    });
    expect(enrichEnturMobilityItems).toHaveBeenNthCalledWith(2, [], [expect.any(Object)], {
      transport: expect.any(Object),
      scope: "detail",
    });
  });

  it("delegates map context selection and marks it as static", async () => {
    const context: DataSourceMapContext = {
      geojson: { type: "FeatureCollection", features: [] },
    };
    vi.mocked(buildSharedMobilityMapContext).mockResolvedValue(context);
    const shared = definition();
    const options = { providerIds: ["provider"] };

    const result = await shared.provider.getMapContext?.(BBOX, {}, options);

    expect(buildSharedMobilityMapContext).toHaveBeenCalledWith(
      BBOX,
      FORM_FACTORS,
      expect.any(Object),
      options,
    );
    expect(result?.data).toBe(context);
    expect(result?.freshness.hasRealtimeData).toBe(false);
  });
});
