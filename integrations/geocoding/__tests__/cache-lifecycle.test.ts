import type { AutocompleteResult, IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";
import { MemCache } from "../mem-cache.js";
import {
  clearPlaceLookupCaches,
  reverseGeocodeCountry,
  setPlaceLookupNominatimUrl,
} from "../place-lookup.js";
import type { GeocodingProvider } from "../types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearPlaceLookupCaches();
});

function harness(label: string, shared = new Map<string, unknown>()) {
  const listeners = new Set<(event: { available: boolean }) => void>();
  const shutdown: Array<() => Promise<void>> = [];
  const autocomplete = vi.fn<GeocodingProvider["autocomplete"]>(async () => [
    { id: label, label, type: "poi" },
  ]);
  const provider: GeocodingProvider = {
    autocomplete,
    geocode: async () => [],
    reverseGeocode: async () => null,
  };
  const keys: string[] = [];
  const ctx = createMockIntegrationContext({
    config: { provider: "maptiler" },
    cache: {
      get: async <T>(key: string) => (shared.get(key) as T | undefined) ?? null,
      set: async (key, value) => {
        shared.set(key, value);
      },
      del: async (key) => {
        shared.delete(key);
      },
      withCache: async <T>(
        key: string,
        _ttl: number,
        load: (signal: AbortSignal) => Promise<T>,
      ) => {
        keys.push(key);
        if (shared.has(key)) return shared.get(key) as T;
        const value = await load(new AbortController().signal);
        // The host's epoch fence is tested at the actual Redis boundary.
        return value;
      },
      onInvalidate(listener) {
        listeners.add(listener);
        listener({ available: true });
        return () => listeners.delete(listener);
      },
    },
  });
  ctx.onShutdown = (callback) => {
    shutdown.push(callback);
  };
  const integration = {
    id: "geocoding-maptiler",
    config: { endpoint: `https://${label}.example` },
    resolvedServices: {
      geocoder: { serviceId: "photon", url: "https://first-service.example", enabled: true },
    },
    providers: new Map([["geocoding", [provider]]]),
  };
  ctx.getIntegrationsByDomain = () =>
    [integration] as unknown as ReturnType<IntegrationContext["getIntegrationsByDomain"]>;
  setup(ctx);
  const call = async () => {
    const route = ctx.registered.routes.find((entry) => entry.path === "/autocomplete");
    if (!route) throw new Error("Missing autocomplete route");
    let result: unknown;
    await route.handler({ query: { q: "coffee" }, params: {}, body: undefined, headers: {} }, {
      send: (value: unknown) => {
        result = value;
      },
      header: () => undefined,
      status: () => undefined,
      type: () => undefined,
    } as never);
    return result as AutocompleteResult[];
  };
  return {
    call,
    autocomplete,
    keys,
    listeners,
    shutdown,
    integration,
    invalidate(available = true) {
      shared.clear();
      for (const listener of listeners) listener({ available });
    },
  };
}

describe("geocoding cache ownership", () => {
  it("keeps different provider configurations out of each other's local and shared keys", async () => {
    const shared = new Map<string, unknown>();
    const a = harness("provider-a", shared);
    const b = harness("provider-b", shared);
    expect((await a.call())[0]?.id).toBe("provider-a");
    expect((await b.call())[0]?.id).toBe("provider-b");
    expect(a.keys[0]).not.toBe(b.keys[0]);
  });

  it("picks up changed provider configuration within the same orchestrator", async () => {
    const h = harness("first");
    await h.call();
    h.integration.config.endpoint = "https://second.example";
    h.autocomplete.mockResolvedValue([{ id: "second", label: "second", type: "poi" }]);
    expect((await h.call())[0]?.id).toBe("second");
    expect(h.keys[0]).not.toBe(h.keys[1]);
  });

  it("serves soft-stale results immediately while refreshing in the background", async () => {
    vi.useFakeTimers();
    const h = harness("stale");
    await h.call();
    const refresh = Promise.withResolvers<AutocompleteResult[]>();
    h.autocomplete.mockReturnValue(refresh.promise);
    vi.advanceTimersByTime(5 * 60_000);
    expect((await h.call())[0]?.id).toBe("stale");
    expect(h.autocomplete).toHaveBeenCalledTimes(2);
    refresh.resolve([{ id: "refreshed", label: "refreshed", type: "poi" }]);
    await vi.waitFor(async () => expect((await h.call())[0]?.id).toBe("refreshed"));
  });

  it("keeps soft-stale results when a background refresh fails", async () => {
    vi.useFakeTimers();
    const h = harness("stale");
    await h.call();
    h.autocomplete.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(5 * 60_000);
    expect((await h.call())[0]?.id).toBe("stale");
    await Promise.resolve();
    expect((await h.call())[0]?.id).toBe("stale");
  });

  it("separates results after a provider's bound service changes", async () => {
    const h = harness("first");
    await h.call();
    h.integration.resolvedServices.geocoder.url = "https://second-service.example";
    h.autocomplete.mockResolvedValue([{ id: "second", label: "second", type: "poi" }]);
    expect((await h.call())[0]?.id).toBe("second");
    expect(h.keys[0]).not.toBe(h.keys[1]);
  });

  it("drops local values on host invalidation and unregisters when retired", async () => {
    const h = harness("before-clear");
    await h.call();
    h.autocomplete.mockResolvedValue([{ id: "after-clear", label: "fresh", type: "poi" }]);
    h.invalidate();
    expect((await h.call())[0]?.id).toBe("after-clear");
    await Promise.all(h.shutdown.map((stop) => stop()));
    expect(h.listeners.size).toBe(0);
  });

  it("does not let a pre-clear response overwrite a newer local result", async () => {
    const h = harness("initial");
    let complete!: (rows: AutocompleteResult[]) => void;
    h.autocomplete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const old = h.call();
    await vi.waitFor(() => expect(h.autocomplete).toHaveBeenCalledTimes(1));
    h.invalidate();
    h.autocomplete.mockResolvedValue([{ id: "new", label: "new", type: "poi" }]);
    expect((await h.call())[0]?.id).toBe("new");
    complete([{ id: "old", label: "old", type: "poi" }]);
    await old;
    expect((await h.call())[0]?.id).toBe("new");
  });

  it("bypasses local results during invalidation-channel outages", async () => {
    const h = harness("healthy");
    await h.call();
    h.invalidate(false);
    await h.call();
    h.autocomplete.mockResolvedValue([{ id: "latest", label: "latest", type: "poi" }]);
    expect((await h.call())[0]?.id).toBe("latest");
    expect(h.autocomplete).toHaveBeenCalledTimes(3);
  });
});

describe("autocomplete freshness", () => {
  it("evicts the least recently read value without evicting a recent hit", () => {
    const cache = new MemCache<string>(2);
    cache.set("a", "first", 5_000, 10_000);
    cache.set("b", "second", 5_000, 10_000);
    expect(cache.get("a")?.data).toBe("first");
    cache.set("c", "third", 5_000, 10_000);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")?.data).toBe("first");
    expect(cache.get("c")?.data).toBe("third");
  });

  it("expires at the hard deadline without extending age on hits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    const cache = new MemCache<string>(2);
    cache.set("a", "value", 5_000, 10_000);
    vi.advanceTimersByTime(5_001);
    expect(cache.get("a")).toEqual({ data: "value", stale: true });
    vi.advanceTimersByTime(4_999);
    expect(cache.get("a")).toBeNull();
  });
});

it("does not reuse country results after changing the Nominatim endpoint", async () => {
  const fetch = vi.fn(
    async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          address: { country_code: String(input).includes("first.example") ? "de" : "fr" },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  setPlaceLookupNominatimUrl("https://first.example");
  expect(await reverseGeocodeCountry(10.1, 20.2)).toBe("de");
  setPlaceLookupNominatimUrl("https://second.example");
  expect(await reverseGeocodeCountry(10.1, 20.2)).toBe("fr");
});

describe("country cache lifecycle", () => {
  it("caches successful negative results until the fixed 24-hour deadline", async () => {
    vi.useFakeTimers();
    clearPlaceLookupCaches();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ address: {} })));
    vi.stubGlobal("fetch", fetch);
    expect(await reverseGeocodeCountry(10, 20)).toBeNull();
    vi.advanceTimersByTime(24 * 3600_000 - 1);
    expect(await reverseGeocodeCountry(10, 20)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    fetch.mockImplementation(
      async () => new Response(JSON.stringify({ address: { country_code: "FR" } })),
    );
    expect(await reverseGeocodeCountry(10, 20)).toBe("fr");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds entries to 4096 and preserves recent reads", async () => {
    clearPlaceLookupCaches();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ address: { country_code: "de" } }));
      }),
    );
    const call = (i: number) => reverseGeocodeCountry((i % 181) - 90, Math.floor(i / 181) - 180);
    await call(0);
    await call(1);
    await call(0);
    for (let i = 2; i <= 4096; i++) await call(i);
    expect(calls).toBe(4097);
    await call(0);
    expect(calls).toBe(4097);
    await call(1);
    expect(calls).toBe(4098);
  });

  it("does not refill local results after an overlapping clear", async () => {
    clearPlaceLookupCaches();
    const old = Promise.withResolvers<Response>();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ address: { country_code: "fr" } })),
    );
    fetch.mockReturnValueOnce(old.promise);
    vi.stubGlobal("fetch", fetch);
    const pending = reverseGeocodeCountry(10, 20);
    clearPlaceLookupCaches();
    expect(await reverseGeocodeCountry(10, 20)).toBe("fr");
    old.resolve(new Response(JSON.stringify({ address: { country_code: "de" } })));
    expect(await pending).toBe("de");
    expect(await reverseGeocodeCountry(10, 20)).toBe("fr");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
