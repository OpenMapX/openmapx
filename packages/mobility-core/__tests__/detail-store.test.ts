import { describe, expect, it } from "vitest";
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
  return { cache, writes };
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
    const firstReplica = new SharedMobilityDetailStore(600, 1);
    firstReplica.setCache(cache);
    const items = [station("provider-a", "station-1"), vehicle("provider-a", "vehicle-1")];
    await firstReplica.store(items);

    expect(writes).toHaveLength(1);

    const freshReplica = new SharedMobilityDetailStore(600, 1);
    freshReplica.setCache(cache);
    expect(await freshReplica.get(items[0]?.id ?? "")).toMatchObject({ nativeId: "station-1" });
    expect(await freshReplica.get(items[1]?.id ?? "")).toMatchObject({ nativeId: "vehicle-1" });
  });

  it("survives L1 eviction while keeping providers isolated", async () => {
    const { cache } = sharedCache();
    const store = new SharedMobilityDetailStore(600, 1);
    store.setCache(cache);
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
    const writer = new SharedMobilityDetailStore(600, 1);
    writer.setCache(cache);
    await writer.store([direct]);

    const reader = new SharedMobilityDetailStore(600, 1);
    reader.setCache(cache);
    expect(await reader.get(direct.id)).toEqual(direct);
  });
});
