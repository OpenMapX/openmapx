import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import type { GbfsCatalogClient } from "@openmapx/mobility-core/gbfs-catalog";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { CacheClient } from "../context.js";
import { createSharedMobilityProvider } from "../shared-mobility-provider-factory.js";

const bbox = { west: 10, south: 60, east: 11, north: 61 };
const rawEnrichment = {
  stations: [
    {
      id: "one",
      address: "New Entur field",
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
};
function item(nativeId: string): SharedMobilityStation {
  return {
    id: `gbfs/entur-system/${nativeId}`,
    nativeId,
    systemId: "entur-system",
    name: "Station",
    coordinates: [10.5, 60.5],
    availableVehicles: 1,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["gbfs/entur-system"],
    contributors: [{ sourceId: "gbfs", name: "GBFS" }],
  };
}
function harness(reply: (body: string) => Promise<unknown>, maxL1Items = 100) {
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  const snapshotWrites: Array<{ key: string; expiresAt: number }> = [];
  const cache: CacheClient = {
    get: async <T>(key: string) => {
      const entry = values.get(key);
      return entry && entry.expiresAt > Date.now() ? (structuredClone(entry.value) as T) : null;
    },
    set: async (key, value, ttl = 600) => {
      const expiresAt = Date.now() + ttl * 1000;
      values.set(key, { value: structuredClone(value), expiresAt });
      if (key.startsWith("shared-mobility-detail:")) snapshotWrites.push({ key, expiresAt });
    },
    del: async (key) => {
      values.delete(key);
    },
    withCache: async function <T>(
      key: string,
      ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) {
      const retained = await this.get<T>(key);
      if (retained !== null) return retained;
      const data = await load(new AbortController().signal);
      await this.set(key, data, ttl);
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
  const transport = {
    userAgent: "test",
    fetchJson: vi.fn(async (_url, options) => ({ data: await reply(String(options?.body)) })),
    fetchText: async () => "",
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  } as MobilityHttpTransport;
  let enrichmentEnabled = true;
  const runtime = {
    enrichEnturMobilityItems: (stations, vehicles, scope, resolveContributors) =>
      enrichmentEnabled
        ? enrichEnturMobilityItems(stations, vehicles, {
            cache,
            catalog,
            transport,
            scope,
            resolveContributors,
          })
        : Promise.resolve(),
  } as SharedMobilityRuntime;
  let inventory = [item("one"), item("two")];
  const loadInventory = vi.fn(async () => ({ stations: structuredClone(inventory), vehicles: [] }));
  const provider = () =>
    createSharedMobilityProvider({
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
      detailStore: { ttlSeconds: 600, maxL1Items },
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
      loadInventory,
    });
  return {
    cache,
    provider,
    snapshotWrites,
    loadInventory,
    setInventory: (next: SharedMobilityStation[]) => {
      inventory = next;
    },
    disableEnrichment: () => {
      enrichmentEnabled = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
it.each([
  ["inventory", "shared-mobility-detail:v2:", 100],
  ["enrichment", "shared-mobility-detail:enrichment:v1:", 100],
  ["inventory", "shared-mobility-detail:v2:", 1],
  ["enrichment", "shared-mobility-detail:enrichment:v1:", 1],
] as const)(
  "an unrelated acquisition during the %s lookup preserves retained enrichment (%s, L1 limit %s)",
  async (seam, prefix, maxL1Items) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness(
      async (body) =>
        body.includes("pricingPlans") ? rawEnrichment : { stations: [], vehicles: [] },
      maxL1Items,
    );
    h.setInventory([item("one")]);
    const original = h.provider();
    await original.search(bbox);
    vi.setSystemTime(100_000);
    const enriched = await h.provider().getDetail("s:gbfs/entur-system/one");
    expect(enriched.data?.contributors?.map((credit) => credit.sourceId)).toEqual([
      "gbfs",
      "entur-mobility",
    ]);
    h.disableEnrichment();
    // Keep a base-only L1 for the patch seam; start without L1 for the inventory seam.
    const reader = seam === "inventory" ? h.provider() : original;
    const started = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const get = h.cache.get;
    let armed = true;
    h.cache.get = async <T>(key: string) => {
      const value = await get<T>(key);
      if (armed && key.startsWith(prefix)) {
        armed = false;
        started.resolve();
        await resumed.promise;
      }
      return value;
    };
    const pending = reader.getDetail("s:gbfs/entur-system/one");
    await started.promise;
    vi.setSystemTime(200_000);
    h.setInventory([item("two")]);
    await reader.search(bbox);
    resumed.resolve();
    const detail = await pending;
    expect(detail.data).toEqual(enriched.data);
    expect(detail.attributions).toEqual(enriched.attributions);
    expect(detail.freshness.fetchedAt).toBe(new Date(0).toISOString());
    expect(h.snapshotWrites).toHaveLength(3);
    expect(h.snapshotWrites.filter((write) => write.key.includes(":enrichment:"))).toEqual([
      expect.objectContaining({ expiresAt: 600_000 }),
    ]);
    if (maxL1Items === 1) {
      // Completing an old lookup must not resurrect an entry evicted by the newer search.
      await h.cache.del("shared-mobility-detail:v2:gbfs%2Fentur-system");
      expect((await reader.getDetail("s:gbfs/entur-system/one")).data).toBeNull();
    }
    vi.setSystemTime(600_000);
    expect((await reader.getDetail("s:gbfs/entur-system/one")).data).toBeNull();
    expect((await h.provider().getDetail("s:gbfs/entur-system/one")).data).toBeNull();
    expect((await reader.getDetail("s:gbfs/entur-system/two")).data).not.toBeNull();
  },
);

it.each([false, true])(
  "detail reads preserve original inventory deadlines on a fresh replica (real enrichment: %s)",
  async (changes) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness(async (body) =>
      changes && body.includes("pricingPlans") ? rawEnrichment : { stations: [], vehicles: [] },
    );
    const first = h.provider();
    await first.search(bbox);
    vi.setSystemTime(500_000);
    const detail = await first.getDetail("s:gbfs/entur-system/one");
    expect(detail.data?.contributors?.map((a) => a.sourceId)).toEqual(
      changes ? ["gbfs", "entur-mobility"] : ["gbfs"],
    );
    expect(detail.freshness.fetchedAt).toBe(new Date(0).toISOString());
    vi.setSystemTime(550_000);
    const replica = h.provider();
    expect((await replica.getDetail("s:gbfs/entur-system/one")).data?.contributors).toEqual(
      detail.data?.contributors,
    );
    expect((await replica.getDetail("s:gbfs/entur-system/two")).data?.id).toBe(
      "s:gbfs/entur-system/two",
    );
    expect(h.snapshotWrites).toHaveLength(changes ? 2 : 1);
    expect(h.snapshotWrites.every((write) => write.expiresAt <= 600_000)).toBe(true);
    vi.setSystemTime(700_000);
    const afterExpiry = h.provider();
    expect((await afterExpiry.getDetail("s:gbfs/entur-system/one")).data).toBeNull();
    expect((await afterExpiry.getDetail("s:gbfs/entur-system/two")).data).toBeNull();
    expect((await first.getDetail("s:gbfs/entur-system/one")).data).toBeNull();
    expect(h.loadInventory).toHaveBeenCalledTimes(1);
  },
);
it("a delayed enrichment cannot replace a newer acquisition's availability or receipt on another replica", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let complete!: (data: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const h = harness(async (body) => {
    if (body.includes("pricingPlans")) {
      entered();
      return blocked;
    }
    return { stations: [], vehicles: [] };
  });
  const old = h.provider();
  await old.search(bbox);
  vi.setSystemTime(400_000);
  const oldDetail = old.getDetail("s:gbfs/entur-system/one");
  await started;
  vi.setSystemTime(450_000);
  const newer = {
    ...item("one"),
    availableVehicles: 7,
    contributors: [{ sourceId: "new-feed", name: "New acquisition" }],
  };
  h.setInventory([newer]);
  await h.provider().search(bbox);
  complete(rawEnrichment);
  await oldDetail;
  vi.setSystemTime(470_000);
  h.disableEnrichment();
  const fresh = h.provider();
  const detail = await fresh.getDetail("s:gbfs/entur-system/one");
  expect(detail.data?.sections[0].rows?.[0]?.[1]).toBe(7);
  expect(detail.data?.contributors).toEqual(newer.contributors);
  expect(detail.freshness.fetchedAt).toBe(new Date(450_000).toISOString());
  expect(h.loadInventory).toHaveBeenCalledTimes(2);
});

it("an enrichment completing after inventory expiry cannot revive the old availability", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let complete!: (data: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const h = harness(async (body) => {
    if (body.includes("pricingPlans")) {
      entered();
      return blocked;
    }
    return { stations: [], vehicles: [] };
  });
  const provider = h.provider();
  await provider.search(bbox);
  vi.setSystemTime(500_000);
  const detail = provider.getDetail("s:gbfs/entur-system/one");
  await started;
  vi.setSystemTime(700_000);
  complete(rawEnrichment);
  expect((await detail).data).toBeNull();
  expect((await h.provider().getDetail("s:gbfs/entur-system/one")).data).toBeNull();
});
