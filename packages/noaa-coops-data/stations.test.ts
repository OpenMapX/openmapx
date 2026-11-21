import {
  createFencedMemoryCache,
  createNoopLogger,
  createPassthroughCache,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { assert, expect, it } from "vitest";
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

it("captures NOAA catalog receipts before caching and preserves them across caller metadata changes", async () => {
  const cache = createMockCacheClient();
  const log = createNoopLogger();
  const http = fakeHttpClient(() => ({
    stations: [{ id: "1", name: "Boston", lat: 42, lng: -71 }],
  }));
  const original = [{ sourceId: "noaa-co-ops", name: "original-notice" }];
  const first = await loadStations(http, cache, log, undefined, original);
  const [notice] = original;
  assert.isDefined(notice);
  notice.name = "replacement-notice";
  const second = await loadStations(http, cache, log, undefined, original);
  expect(second[0]?.contributors).toEqual([{ sourceId: "noaa-co-ops", name: "original-notice" }]);
  expect(http.calls).toHaveLength(3);
  expect(http.calls[0]).toMatchObject({
    method: "get",
    url: "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json",
    options: {
      params: { type: "tidepredictions", units: "english", application: "OpenMapX" },
      maxResponseBytes: 16 * 1024 * 1024,
    },
  });
  const receipt = first[0]?.contributors?.[0];
  if (!receipt) throw new Error("missing receipt");
  receipt.name = "mutated-consumer";
  expect(
    (await loadStations(http, cache, log, undefined, original))[0]?.contributors?.[0]?.name,
  ).toBe("original-notice");
});
it("captures authoritative empty and excludes legacy raw catalogs from receipt-aware calls", async () => {
  const cache = createMockCacheClient();
  const log = createNoopLogger();
  await cache.set(
    "stations:catalog",
    [{ id: "old", name: "Old", lat: 42, lng: -71, types: ["water-level"] }],
    500,
  );
  const http = fakeHttpClient(() => ({
    stations: [{ id: "new", name: "New", lat: 42, lng: -71 }],
  }));
  expect((await loadStations(http, cache, log, undefined, []))[0]).toMatchObject({
    id: "new",
    contributors: [],
  });
  expect((await loadStations(http, cache, log))[0]).toMatchObject({ id: "old" });
});

it("keeps a catalog fetched across an admin cache clear out of the cache", async () => {
  const cache = createFencedMemoryCache();
  let release!: () => void;
  let fetching!: () => void;
  const started = new Promise<void>((resolve) => {
    fetching = resolve;
  });
  const http = fakeHttpClient(async () => {
    fetching();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { stations: [{ id: "1", name: "Boston", lat: 42, lng: -71 }] };
  });

  const loading = loadStations(http, cache, createNoopLogger(), ["tide-predictions"], []);
  await started;
  cache.clear();
  release();

  expect((await loading).map((station) => station.id)).toEqual(["1"]);
  expect(cache.values.size).toBe(0);
});

it("logs a failed station list and keeps the other types", async () => {
  const warnings: string[] = [];
  const http = fakeHttpClient((req) =>
    String((req.options as { params?: { type?: string } }).params?.type) === "waterlevels"
      ? httpStatus(503)
      : { stations: [{ id: "1", name: "Boston", lat: 42, lng: -71 }] },
  );
  const stations = await loadStations(
    http,
    createPassthroughCache(),
    { ...createNoopLogger(), warn: (message: string) => warnings.push(message) },
    ["tide-predictions", "water-level"],
  );

  expect(stations.map((station) => station.types)).toEqual([["tide-predictions"]]);
  expect(warnings).toEqual(["noaa-coops: MDAPI water-level fetch failed: HTTP 503"]);
});
