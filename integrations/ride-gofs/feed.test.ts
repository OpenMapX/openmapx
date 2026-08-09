import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import {
  FEED_DOCUMENTS,
  LEAN_FEED_CONFIG,
  LEAN_FEED_DOCUMENTS,
  REALTIME_BOOKING,
} from "./__fixtures__/feed.js";
import { createGofsFeedClient } from "./feed.js";

const feedConfig = { id: "example", name: "Example Taxi", url: "https://feed.example/gofs.json" };

/** `createMockIntegrationContext` defaults to a cache that stores nothing. */
function memoryCache() {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => (store.get(k) ?? null) as never,
    set: async (k: string, v: unknown) => void store.set(k, v),
    del: async (k: string) => void store.delete(k),
    withCache: async <T>(_k: string, _t: number, fn: () => Promise<T>) => fn(),
  };
}

function clientWith(docs: Record<string, unknown> = FEED_DOCUMENTS) {
  const ctx = createMockIntegrationContext({ id: "ride-gofs", config: {} });
  const fetchJson = vi.fn(async (url: string) => {
    if (!(url in docs)) throw new Error(`404 ${url}`);
    return docs[url];
  });
  return { ctx, fetchJson, client: createGofsFeedClient(ctx, feedConfig, fetchJson) };
}

describe("loadStatic", () => {
  it("resolves every published static file through discovery", async () => {
    const { client } = clientWith();
    const feed = await client.loadStatic();
    expect(feed.system.name).toBe("Example Taxi Registry");
    expect(feed.system.timezone).toBe("America/Toronto");
    expect(feed.brands.map((b) => b.brand_id)).toEqual(["regular", "large"]);
    expect(feed.zones).toHaveLength(1);
    expect(feed.rules).toHaveLength(2);
    expect(feed.calendars).toHaveLength(1);
    expect(feed.fares).toHaveLength(1);
    expect(feed.bookingRules).toHaveLength(1);
    expect(feed.realtimeBookingUrl).toBe("https://feed.example/realtime_booking");
  });

  it("tolerates a feed that omits the optional files", async () => {
    const trimmed = { ...FEED_DOCUMENTS };
    delete trimmed["https://feed.example/fares.json"];
    delete trimmed["https://feed.example/booking_rules.json"];
    const { client } = clientWith(trimmed);
    const feed = await client.loadStatic();
    expect(feed.fares).toEqual([]);
    expect(feed.bookingRules).toEqual([]);
  });

  it("serves the second call from cache without refetching", async () => {
    const ctx = createMockIntegrationContext({
      id: "ride-gofs",
      config: {},
      cache: memoryCache(),
    });
    const fetchJson = vi.fn(async (url: string) => {
      if (!(url in FEED_DOCUMENTS)) throw new Error(`404 ${url}`);
      return FEED_DOCUMENTS[url];
    });
    const client = createGofsFeedClient(ctx, feedConfig, fetchJson);

    await client.loadStatic();
    const calls = fetchJson.mock.calls.length;
    await client.loadStatic();
    expect(fetchJson.mock.calls.length).toBe(calls);
  });

  it("never writes a ttl-0 feed to the shared cache", async () => {
    // A feed declaring ttl 0 says its data can change at any moment, so a
    // later request (a fresh client) must not be served a stored copy. Within
    // one client the in-flight memo still applies — that is per-request work,
    // not caching.
    const cache = memoryCache();
    const fetchJson = vi.fn(async (url: string) => {
      const doc = LEAN_FEED_DOCUMENTS[url.split("?")[0]];
      if (!doc) throw new Error(`404 ${url}`);
      return doc;
    });
    const makeClient = () =>
      createGofsFeedClient(
        createMockIntegrationContext({ id: "ride-gofs", config: {}, cache }),
        LEAN_FEED_CONFIG,
        fetchJson,
      );

    await makeClient().loadStatic();
    const calls = fetchJson.mock.calls.length;
    await makeClient().loadStatic();
    expect(fetchJson.mock.calls.length).toBeGreaterThan(calls);
  });

  it("loads the static files once per client, even for a ttl-0 feed", async () => {
    // The live Freebee feed sends ttl 0 on every file, so nothing is cached.
    // A single quote resolves availability, realtime booking and wait times —
    // without a per-client memo that is three full downloads of every file.
    const ctx = createMockIntegrationContext({ id: "ride-gofs", config: {} });
    const fetchJson = vi.fn(async (url: string) => {
      const doc = LEAN_FEED_DOCUMENTS[url.split("?")[0]];
      if (!doc) throw new Error(`404 ${url}`);
      return doc;
    });
    const client = createGofsFeedClient(ctx, LEAN_FEED_CONFIG, fetchJson);

    await Promise.all([client.loadStatic(), client.loadStatic(), client.loadStatic()]);
    const discoveryFetches = fetchJson.mock.calls.filter(([u]) => u === LEAN_FEED_CONFIG.url);
    expect(discoveryFetches).toHaveLength(1);
  });

  it("retries after a failure rather than memoising the rejection", async () => {
    const ctx = createMockIntegrationContext({ id: "ride-gofs", config: {} });
    let failFirst = true;
    const fetchJson = vi.fn(async (url: string) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("transient");
      }
      const doc = LEAN_FEED_DOCUMENTS[url.split("?")[0]];
      if (!doc) throw new Error(`404 ${url}`);
      return doc;
    });
    const client = createGofsFeedClient(ctx, LEAN_FEED_CONFIG, fetchJson);

    await expect(client.loadStatic()).rejects.toThrow("transient");
    await expect(client.loadStatic()).resolves.toMatchObject({ system: { name: "Freebee" } });
  });

  it("throws when discovery itself cannot be fetched", async () => {
    const { client } = clientWith({});
    await expect(client.loadStatic()).rejects.toThrow();
  });
});

describe("fetchRealtimeBooking", () => {
  it("passes pickup and dropoff as GOFS query parameters", async () => {
    const docs = { ...FEED_DOCUMENTS };
    const { client, fetchJson } = clientWith(docs);
    fetchJson.mockImplementation(async (url: string) => {
      if (url.startsWith("https://feed.example/realtime_booking")) return REALTIME_BOOKING;
      if (!(url in docs)) throw new Error(`404 ${url}`);
      return docs[url];
    });

    const entries = await client.fetchRealtimeBooking({
      pickup: [-73.57, 45.5],
      dropoff: [-73.6, 45.52],
    });

    const called = fetchJson.mock.calls.map(([u]) => u).find((u) => u.includes("realtime_booking"));
    const url = new URL(called ?? "");
    expect(url.searchParams.get("pickup_lat")).toBe("45.5");
    expect(url.searchParams.get("pickup_lon")).toBe("-73.57");
    expect(url.searchParams.get("drop_off_lat")).toBe("45.52");
    expect(url.searchParams.get("drop_off_lon")).toBe("-73.6");
    expect(entries[0].brand_id).toBe("regular");
  });

  it("returns an empty list when the feed publishes no realtime_booking", async () => {
    const docs = { ...FEED_DOCUMENTS };
    docs["https://feed.example/gofs.json"] = {
      ttl: 300,
      data: { en: { feeds: [{ name: "zones", url: "https://feed.example/zones.json" }] } },
    };
    const { client } = clientWith(docs);
    expect(await client.fetchRealtimeBooking({ pickup: [-73.57, 45.5] })).toEqual([]);
  });
});
