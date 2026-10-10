import type { DataSourceResult } from "@openmapx/core";
import type {
  CacheClient,
  IntegrationContext,
  MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

const FRESHNESS = { fetchedAt: "2026-10-04T10:00:00.000Z", hasRealtimeData: false, isStale: false };
const QUERY = { west: "13.3", south: "52.4", east: "13.5", north: "52.6" };

const result: DataSourceResult = {
  id: "s1",
  name: "Station",
  coordinates: [13.4, 52.5],
  source: "src",
  variant: "open",
};

/** A cache that stores what `shouldCache` lets it, as the host's does. */
function memoryCache(): CacheClient {
  const store = new Map<string, unknown>();
  return {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
    async withCache<T>(
      key: string,
      _ttl: number,
      fn: (signal: AbortSignal) => Promise<T>,
      _callerSignal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ): Promise<T> {
      if (store.has(key)) return store.get(key) as T;
      const value = await fn(new AbortController().signal);
      if (shouldCache?.(value) ?? true) store.set(key, value);
      return value;
    },
  };
}

function provider(over: Partial<MobilityDataSourceProvider> = {}): MobilityDataSourceProvider {
  return {
    id: "fuel",
    meta: { minZoom: 8, showResultsList: true, markerStyle: { type: "icon" } },
    attribution: [],
    getFilters: async () => [],
    search: vi.fn(async () => ({ data: [result], attributions: [], freshness: FRESHNESS })),
    getDetail: async () => ({ data: null, attributions: [], freshness: FRESHNESS }),
    ...over,
  } as MobilityDataSourceProvider;
}

function ctxWith(p: MobilityDataSourceProvider) {
  const ctx = createMockIntegrationContext({ id: "data-source", cache: memoryCache() });
  const integration = {
    manifest: { id: p.id, frontend: { searchCategory: { label: "Gas Stations" } } },
    providers: new Map([["data-source", [p]]]),
  };
  (
    ctx as { getIntegrationsByDomain: IntegrationContext["getIntegrationsByDomain"] }
  ).getIntegrationsByDomain = ((domain: string) =>
    domain === "data-source" ? [integration] : []) as IntegrationContext["getIntegrationsByDomain"];
  setup(ctx);
  return ctx;
}

function reply() {
  const send = vi.fn();
  return { send, status: vi.fn(() => ({ send })), header: vi.fn(), type: vi.fn() };
}

function route(ctx: ReturnType<typeof ctxWith>, path: string) {
  return ctx.registered.routes.find((r) => r.method === "GET" && r.path === path)!.handler;
}

async function search(ctx: ReturnType<typeof ctxWith>) {
  const res = reply();
  await route(ctx, "/:id/search")(
    { query: QUERY, params: { id: "fuel" }, body: undefined, headers: {} },
    res,
  );
  return res;
}

describe("data-source search route", () => {
  it.each(["area", "unavailable"] as const)(
    "passes a partial (%s) answer on and never caches it",
    async (partial) => {
      const p = provider({
        search: vi.fn(async () => ({
          data: [result],
          attributions: [],
          freshness: FRESHNESS,
          partial,
        })),
      });
      const ctx = ctxWith(p);

      const first = await search(ctx);
      await search(ctx);

      expect(p.search).toHaveBeenCalledTimes(2);
      expect(first.send).toHaveBeenCalledWith({
        data: [result],
        attributions: [],
        freshness: FRESHNESS,
        partial,
      });
      expect(first.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    },
  );

  it("caches a complete answer and leaves `partial` out of it", async () => {
    const p = provider();
    const ctx = ctxWith(p);

    const first = await search(ctx);
    await search(ctx);

    expect(p.search).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenCalledWith({
      data: [result],
      attributions: [],
      freshness: FRESHNESS,
    });
  });
});

describe("data-source list route", () => {
  it("lists a data source only while it is available", async () => {
    let available = false;
    const ctx = ctxWith(provider({ isAvailable: () => available }));
    const list = async () => {
      const res = reply();
      await route(ctx, "/")({ query: {}, params: {}, body: undefined, headers: {} }, res);
      return (res.send.mock.calls[0]![0] as { sources: { id: string }[] }).sources;
    };

    expect(await list()).toEqual([]);
    available = true;
    expect((await list()).map((s) => s.id)).toEqual(["fuel"]);
    available = false;
    expect(await list()).toEqual([]);
  });

  it("lists the filters the running provider defines, never a cached earlier set", async () => {
    let filters = [{ id: "old", label: "Old", type: "toggle" as const }];
    const ctx = ctxWith(provider({ getFilters: async () => filters }));
    const list = async () => {
      const res = reply();
      await route(ctx, "/")({ query: {}, params: {}, body: undefined, headers: {} }, res);
      return (res.send.mock.calls[0]![0] as { sources: { filters: { id: string }[] }[] })
        .sources[0]!.filters;
    };

    expect((await list()).map((f) => f.id)).toEqual(["old"]);
    filters = [{ id: "new", label: "New", type: "toggle" as const }];
    expect((await list()).map((f) => f.id)).toEqual(["new"]);
  });

  it("lists a data source that does not say whether it is available", async () => {
    const ctx = ctxWith(provider());
    const res = reply();
    await route(ctx, "/")({ query: {}, params: {}, body: undefined, headers: {} }, res);
    expect(res.send.mock.calls[0]![0]).toMatchObject({ sources: [{ id: "fuel" }] });
  });
});
