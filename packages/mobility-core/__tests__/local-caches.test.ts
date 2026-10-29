import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheClient } from "../src/cache.js";
import { createGbfsCatalogClient } from "../src/gbfs-catalog.js";
import type { MobilityHttpTransport } from "../src/json-transport.js";
import { createNominatimClient } from "../src/nominatim.js";
import { createSharedMobilityRuntime } from "../src/shared-mobility-runtime.js";
import type { GbfsCatalogEntry } from "../src/types/shared-mobility.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transport(json: (url: string) => Promise<unknown>): MobilityHttpTransport {
  return {
    userAgent: "OpenMapX/test",
    fetchJson: async <T>(url: string) => (await json(url)) as T,
    fetchText: async () => "Country Code,Name,Location,System ID,URL,Auto-Discovery URL",
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  };
}

const cache: CacheClient = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  withCache: async (_key, _ttl, load) => load(new AbortController().signal),
};
function entry(id: number, url = `https://feed.test/${id}/gbfs.json`): GbfsCatalogEntry {
  return {
    systemId: String(id),
    autoDiscoveryUrl: url,
    countryCode: "DE",
    location: "Berlin",
    name: String(id),
    url,
  };
}
function discovery(url: string) {
  return {
    version: "2.3",
    data: {
      en: {
        feeds: [
          { name: "station_information", url: new URL("stations.json", url).href },
          { name: "vehicle_types", url: new URL("types.json", url).href },
        ],
      },
    },
  };
}
function feeds(url: string) {
  if (url.endsWith("gbfs.json")) return discovery(url);
  if (url.endsWith("types.json"))
    return {
      data: {
        vehicle_types: [
          { vehicle_type_id: "bike", form_factor: "bicycle", propulsion_type: "human" },
        ],
      },
    };
  return { data: { stations: [{ station_id: "one", name: "One", lat: 52.5, lon: 13.4 }] } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("city local cache", () => {
  it("evicts least recently used results after 4096 distinct coordinates", async () => {
    let calls = 0;
    const client = createNominatimClient({
      transport: transport(async () => ({ address: { city: `city-${++calls}` } })),
    });
    await client.reverseGeocodeCity(0, 0);
    await client.reverseGeocodeCity(0.1, 0);
    expect(await client.reverseGeocodeCity(0, 0)).toBe("city-1");
    for (let i = 2; i <= 4096; i++) await client.reverseGeocodeCity(i / 10, 0);
    expect(await client.reverseGeocodeCity(0, 0)).toBe("city-1");
    expect(await client.reverseGeocodeCity(0.1, 0)).toBe("city-4098");
  });

  it("keeps successful negative results until the strict fixed 24-hour deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = createNominatimClient({
      transport: transport(async () => (++calls === 1 ? {} : { address: { city: "fresh" } })),
    });
    expect(await client.reverseGeocodeCity(52, 13)).toBeNull();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(await client.reverseGeocodeCity(52, 13)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await client.reverseGeocodeCity(52, 13)).toBe("fresh");
  });

  it("retries transport failures without caching them", async () => {
    let calls = 0;
    const client = createNominatimClient({
      transport: transport(async () => {
        if (++calls === 1) throw new Error("offline");
        return { address: { city: "recovered" } };
      }),
    });
    expect(await client.reverseGeocodeCity(52, 13)).toBeNull();
    expect(await client.reverseGeocodeCity(52, 13)).toBe("recovered");
  });

  it("clear fences a pending city result from filling the new generation", async () => {
    const old = deferred<unknown>();
    let calls = 0;
    const client = createNominatimClient({
      transport: transport(async () =>
        ++calls === 1 ? old.promise : { address: { city: "new" } },
      ),
    });
    const pending = client.reverseGeocodeCity(52, 13);
    client.clearCache();
    expect(await client.reverseGeocodeCity(52, 13)).toBe("new");
    old.resolve({ address: { city: "old" } });
    expect(await pending).toBe("old");
    expect(await client.reverseGeocodeCity(52, 13)).toBe("new");
  });
});

describe("GBFS coverage local cache", () => {
  it("separates discovery URLs for the same system and omits data only on a cache hit", async () => {
    const client = createGbfsCatalogClient({
      cache,
      transport: transport(async (url) => feeds(url)),
    });
    expect((await client.probeSystem(entry(1)))?.systemData).toBeDefined();
    const hit = await client.probeSystem(entry(1));
    expect(hit?.systemData).toBeUndefined();
    expect(hit?.vehicleTypes).toEqual(new Set(["bicycle"]));
    expect(
      (await client.probeSystem(entry(1, "https://changed.test/gbfs.json")))?.systemData,
    ).toBeDefined();
  });

  it("bounds resolved coverage to 10000 entries and preserves recent hits", async () => {
    const client = createGbfsCatalogClient({
      cache,
      transport: transport(async (url) => feeds(url)),
    });
    await client.probeSystem(entry(0));
    await client.probeSystem(entry(1));
    await client.probeSystem(entry(0));
    for (let i = 2; i <= 10000; i++) await client.probeSystem(entry(i));
    expect((await client.probeSystem(entry(0)))?.systemData).toBeUndefined();
    expect((await client.probeSystem(entry(1)))?.systemData).toBeDefined();
  });

  it("expires coverage exactly five minutes after completion without refreshing on hits", async () => {
    vi.useFakeTimers();
    const old = deferred<unknown>();
    let calls = 0;
    const client = createGbfsCatalogClient({
      cache,
      transport: transport(async (url) => (++calls === 1 ? old.promise : feeds(url))),
    });
    const pending = client.probeSystem(entry(1));
    vi.advanceTimersByTime(60_000);
    old.resolve(discovery(entry(1).autoDiscoveryUrl));
    await pending;
    vi.advanceTimersByTime(299_999);
    expect((await client.probeSystem(entry(1)))?.systemData).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect((await client.probeSystem(entry(1)))?.systemData).toBeDefined();
  });

  it("clear starts new coalesced work and old completion cannot delete that active probe", async () => {
    const old = deferred<unknown>();
    const fresh = deferred<unknown>();
    let discoveries = 0;
    const client = createGbfsCatalogClient({
      cache,
      transport: transport(async (url) => {
        if (url.endsWith("gbfs.json")) return ++discoveries === 1 ? old.promise : fresh.promise;
        return feeds(url);
      }),
    });
    const oldRequest = client.probeSystem(entry(1));
    client.clearCache();
    const freshRequest = client.probeSystem(entry(1));
    expect(discoveries).toBe(2);
    old.resolve(discovery(entry(1).autoDiscoveryUrl));
    await oldRequest;
    const join = client.probeSystem(entry(1));
    expect(discoveries).toBe(2);
    fresh.resolve(discovery(entry(1).autoDiscoveryUrl));
    const [result, joined] = await Promise.all([freshRequest, join]);
    expect(result?.systemData).toBeDefined();
    expect(joined).toBe(result);
    expect((await client.probeSystem(entry(1)))?.systemData).toBeUndefined();
  });

  it("does not cache failed discovery probes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const client = createGbfsCatalogClient({
      cache,
      transport: transport(async (url) => {
        if (++calls === 1) throw new Error("offline");
        return feeds(url);
      }),
    });
    expect(await client.probeSystem(entry(1))).toBeNull();
    expect((await client.probeSystem(entry(1)))?.systemData).toBeDefined();
  });
});

describe("catalog invalidation", () => {
  it("clear fences deferred catalog loads from replacing the new catalog", async () => {
    const old = deferred<string>();
    let calls = 0;
    const csv = (name: string) =>
      `Country Code,Name,Location,System ID,URL,Auto-Discovery URL\nDE,${name},Berlin,${name},https://feed.test,https://feed.test/gbfs.json`;
    const http = transport(async () => ({ data: { datasets: [] } }));
    http.fetchText = async () => (++calls === 1 ? old.promise : csv("new"));
    const client = createGbfsCatalogClient({ cache, transport: http });
    const pending = client.loadCatalog();
    client.clearCache();
    expect((await client.loadCatalog()).map((item) => item.systemId)).toEqual([
      "new",
      "sharedmobility.ch",
    ]);
    old.resolve(csv("old"));
    expect((await pending).map((item) => item.systemId)).toEqual(["old", "sharedmobility.ch"]);
    expect((await client.loadCatalog()).map((item) => item.systemId)).toEqual([
      "new",
      "sharedmobility.ch",
    ]);
  });
});

describe("runtime invalidation", () => {
  it("clears every event, bypasses disconnected caches, and releases its listener", async () => {
    const listeners = new Set<(event: { available: boolean }) => void>();
    const subscribedCache: CacheClient = {
      ...cache,
      onInvalidate(listener) {
        listeners.add(listener);
        listener({ available: true });
        return () => {
          listeners.delete(listener);
        };
      },
    };
    let cities = 0;
    const runtime = createSharedMobilityRuntime({
      cache: subscribedCache,
      transport: transport(async (url) =>
        url.includes("/reverse") ? { address: { city: `city-${++cities}` } } : feeds(url),
      ),
    });
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-1");
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-1");
    await runtime.probeSystem(entry(1));
    for (const listener of listeners) listener({ available: false });
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-2");
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-3");
    expect((await runtime.probeSystem(entry(1)))?.systemData).toBeDefined();
    expect((await runtime.probeSystem(entry(1)))?.systemData).toBeDefined();
    for (const listener of listeners) listener({ available: true });
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-4");
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-4");
    for (const listener of listeners) listener({ available: true });
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("city-5");
    runtime.dispose();
    expect(listeners.size).toBe(0);
  });
  it("does not promote results started before a disconnect/reconnect into new caches", async () => {
    const listeners = new Set<(event: { available: boolean }) => void>();
    const subscribedCache: CacheClient = {
      ...cache,
      onInvalidate(listener) {
        listeners.add(listener);
        listener({ available: false });
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const oldCity = deferred<unknown>();
    const oldProbe = deferred<unknown>();
    let cityCalls = 0;
    let probeCalls = 0;
    const runtime = createSharedMobilityRuntime({
      cache: subscribedCache,
      transport: transport(async (url) => {
        if (url.includes("/reverse"))
          return ++cityCalls === 1 ? oldCity.promise : { address: { city: "new" } };
        if (url.endsWith("gbfs.json") && ++probeCalls === 1) return oldProbe.promise;
        return feeds(url);
      }),
    });
    const city = runtime.reverseGeocodeCity(52, 13);
    const probe = runtime.probeSystem(entry(1));
    for (const listener of listeners) listener({ available: true });
    oldCity.resolve({ address: { city: "old" } });
    oldProbe.resolve(discovery(entry(1).autoDiscoveryUrl));
    await Promise.all([city, probe]);
    expect(await runtime.reverseGeocodeCity(52, 13)).toBe("new");
    expect((await runtime.probeSystem(entry(1)))?.systemData).toBeDefined();
    runtime.dispose();
  });
});
