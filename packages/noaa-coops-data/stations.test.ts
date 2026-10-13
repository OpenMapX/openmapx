import { createNoopLogger, createPassthroughCache } from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { loadStations } from "./stations";

function createMockCacheClient() {
  const stored = new Map<string, unknown>();
  return {
    ...createPassthroughCache(),
    get: async <T>(key: string) => (stored.get(key) as T) ?? null,
    set: async <T>(key: string, value: T, _ttl: number) => {
      stored.set(key, value);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());
it("captures NOAA catalog receipts before caching and preserves them across caller metadata changes", async () => {
  const cache = createMockCacheClient();
  const log = createNoopLogger();
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stations: [{ id: "1", name: "Boston", lat: 42, lng: -71 }] }),
  });
  vi.stubGlobal("fetch", fetcher);
  const original = [{ sourceId: "noaa-co-ops", name: "original-notice" }];
  const first = await loadStations(cache, log, undefined, original);
  original[0].name = "replacement-notice";
  const second = await loadStations(cache, log, undefined, original);
  expect(second[0].contributors).toEqual([{ sourceId: "noaa-co-ops", name: "original-notice" }]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const receipt = first[0].contributors?.[0];
  if (!receipt) throw new Error("missing receipt");
  receipt.name = "mutated-consumer";
  expect((await loadStations(cache, log, undefined, original))[0].contributors?.[0].name).toBe(
    "original-notice",
  );
});
it("captures authoritative empty and excludes legacy raw catalogs from receipt-aware calls", async () => {
  const cache = createMockCacheClient();
  const log = createNoopLogger();
  await cache.set(
    "stations:catalog",
    [{ id: "old", name: "Old", lat: 42, lng: -71, types: ["water-level"] }],
    500,
  );
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stations: [{ id: "new", name: "New", lat: 42, lng: -71 }] }),
  });
  vi.stubGlobal("fetch", fetcher);
  expect((await loadStations(cache, log, undefined, []))[0]).toMatchObject({
    id: "new",
    contributors: [],
  });
  expect((await loadStations(cache, log))[0]).toMatchObject({ id: "old" });
});
