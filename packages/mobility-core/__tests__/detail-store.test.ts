import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { CacheClient } from "../src/cache.js";
import { SharedMobilityDetailStore } from "../src/detail-store.js";
import { createMotisRentalId } from "../src/motis-rentals.js";
import type { SharedMobilityStation, SharedMobilityVehicle } from "../src/types/shared-mobility.js";

function sharedCache() {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  const cache: CacheClient = {
    get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
    set: async (key, value) => {
      writes.push(key);
      values.set(key, structuredClone(value));
    },
    del: async (key) => {
      values.delete(key);
    },
    withCache: async (_key, _ttl, load) => load(),
  };
  return { cache, writes, values };
}

function pauseNextLookup(cache: CacheClient, prefix: string) {
  let started!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = cache.get;
  let armed = true;
  cache.get = async <T>(key: string) => {
    const value = structuredClone(await get<T>(key));
    if (armed && key.startsWith(prefix)) {
      armed = false;
      started();
      await resumed;
    }
    return value;
  };
  return { waiting, release };
}

function station(provider: string, nativeId: string): SharedMobilityStation {
  return {
    id: createMotisRentalId("motis-local", provider, "station", nativeId),
    nativeId,
    providerId: createMotisRentalId("motis-local", provider, "provider", provider),
    servingOrigin: "motis-local",
    name: nativeId,
    coordinates: [13.4, 52.5],
    availableVehicles: 1,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: [`mobilitydata:${provider}`],
  };
}

function vehicle(provider: string, nativeId: string): SharedMobilityVehicle {
  return {
    id: createMotisRentalId("motis-local", provider, "vehicle", nativeId),
    nativeId,
    providerId: createMotisRentalId("motis-local", provider, "provider", provider),
    servingOrigin: "motis-local",
    coordinates: [13.4, 52.5],
    formFactor: "bicycle",
    isReserved: false,
    isDisabled: false,
    sources: [`mobilitydata:${provider}`],
  };
}

describe("SharedMobilityDetailStore", () => {
  it("writes one provider snapshot and resolves station and vehicle on a fresh replica", async () => {
    const { cache, writes } = sharedCache();
    const firstReplica = new SharedMobilityDetailStore(cache, 600, 1);
    const items = [station("provider-a", "station-1"), vehicle("provider-a", "vehicle-1")];
    await firstReplica.store(items);

    expect(writes).toHaveLength(1);

    const freshReplica = new SharedMobilityDetailStore(cache, 600, 1);
    expect(await freshReplica.get(items[0]?.id ?? "")).toMatchObject({ nativeId: "station-1" });
    expect(await freshReplica.get(items[1]?.id ?? "")).toMatchObject({ nativeId: "vehicle-1" });
  });

  it("survives L1 eviction while keeping providers isolated", async () => {
    const { cache } = sharedCache();
    const store = new SharedMobilityDetailStore(cache, 600, 1);
    const first = station("provider-a", "same-id");
    const second = station("provider-b", "same-id");
    await store.store([first, second]);

    store.clearL1();
    expect(await store.get(first.id)).toMatchObject({ providerId: first.providerId });
    expect(await store.get(second.id)).toMatchObject({ providerId: second.providerId });
  });

  it("resolves a direct-provider detail after process restart", async () => {
    const { cache } = sharedCache();
    const direct: SharedMobilityVehicle = {
      id: "gbfs/operator-a/vehicle-1",
      nativeId: "vehicle-1",
      systemId: "operator-a",
      coordinates: [13.4, 52.5],
      formFactor: "scooter_standing",
      isReserved: false,
      isDisabled: false,
      sources: ["gbfs/operator-a"],
    };
    const writer = new SharedMobilityDetailStore(cache, 600, 1);
    await writer.store([direct]);

    const reader = new SharedMobilityDetailStore(cache, 600, 1);
    expect(await reader.get(direct.id)).toEqual(direct);
  });
});

afterEach(() => vi.useRealTimers());
it("a fresh subset acquisition cannot renew unrelated retained item deadlines", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { cache } = sharedCache();
  const writer = new SharedMobilityDetailStore(cache, 600, 100);
  const first = station("same-provider", "first");
  const second = station("same-provider", "second");
  await writer.store([first]);
  vi.setSystemTime(300_000);
  await writer.store([second]);
  vi.setSystemTime(700_000);
  const replica = new SharedMobilityDetailStore(cache, 600, 100);
  expect(await replica.get(first.id)).toBeNull();
  expect(await replica.get(second.id)).toEqual(second);
});

describe.each([
  ["inventory", "shared-mobility-detail:v2:"],
  ["enrichment", "shared-mobility-detail:enrichment:v1:"],
])("a paused %s lookup", (_seam, prefix) => {
  it("cannot replace a newer acquisition in this process or a fresh replica", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { cache, writes } = sharedCache();
    const store = new SharedMobilityDetailStore(cache, 600, 100);
    const first = {
      ...station("provider", "one"),
      contributors: [{ sourceId: "first", name: "First" }],
    };
    await store.store([first]);
    if (_seam === "inventory") store.clearL1();
    const pause = pauseNextLookup(cache, prefix);
    const pending = store.getRetained(first.id);
    await pause.waiting;
    vi.setSystemTime(100_000);
    const second = {
      ...first,
      availableVehicles: 7,
      contributors: [{ sourceId: "second", name: "Second" }],
    };
    await store.store([second]);
    pause.release();
    await pending;

    for (const reader of [store, new SharedMobilityDetailStore(cache, 600, 100)]) {
      const retained = await reader.getRetained(first.id);
      expect(retained).toMatchObject({ item: second, acquiredAt: 100_000, expiresAt: 700_000 });
      assert(retained);
      expect(await reader.updateRetained(retained, second)).toBe(false);
    }
    expect(writes).toHaveLength(2);
    vi.setSystemTime(700_000);
    expect(await store.get(first.id)).toBeNull();
    expect(await new SharedMobilityDetailStore(cache, 600, 100).get(first.id)).toBeNull();
    expect(writes).toHaveLength(2);
  });

  it("cannot repopulate L1 after clear while its shared inventory is removed", async () => {
    const { cache, values, writes } = sharedCache();
    const store = new SharedMobilityDetailStore(cache, 600, 100);
    const first = station("provider", "one");
    await store.store([first]);
    if (_seam === "inventory") store.clearL1();
    const pause = pauseNextLookup(cache, prefix);
    const pending = store.getRetained(first.id);
    await pause.waiting;
    store.clearL1();
    values.clear();
    pause.release();
    await pending;
    expect(await store.get(first.id)).toBeNull();
    expect(await new SharedMobilityDetailStore(cache, 600, 100).get(first.id)).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it("cannot retain an acquisition that expires while the lookup is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { cache, writes } = sharedCache();
    const store = new SharedMobilityDetailStore(cache, 600, 100);
    const first = station("provider", "one");
    await store.store([first]);
    if (_seam === "inventory") store.clearL1();
    const pause = pauseNextLookup(cache, prefix);
    const pending = store.getRetained(first.id);
    await pause.waiting;
    vi.setSystemTime(600_000);
    pause.release();
    expect(await pending).toBeNull();
    expect(await store.get(first.id)).toBeNull();
    expect(writes).toHaveLength(1);
  });
});

it("a paused patch lookup cannot discard enrichment already retained for the same acquisition", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { cache, writes } = sharedCache();
  const store = new SharedMobilityDetailStore(cache, 600, 100);
  const first = station("provider", "one");
  await store.store([first]);
  const retained = await store.getRetained(first.id);
  assert(retained);
  const pause = pauseNextLookup(cache, "shared-mobility-detail:enrichment:v1:");
  const pending = store.getRetained(first.id);
  await pause.waiting;
  vi.setSystemTime(100_000);
  const enriched = {
    ...first,
    name: "Enriched station",
    contributors: [{ sourceId: "enricher", name: "Enricher" }],
  };
  expect(await store.updateRetained(retained, enriched)).toBe(true);
  pause.release();
  expect(await pending).toMatchObject({ item: enriched, acquiredAt: 0, expiresAt: 600_000 });
  expect(await store.getRetained(first.id)).toMatchObject({
    item: enriched,
    acquiredAt: 0,
    expiresAt: 600_000,
  });
  expect(writes).toHaveLength(2);
});
