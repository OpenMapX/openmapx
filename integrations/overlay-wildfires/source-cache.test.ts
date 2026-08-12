import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWithFreshAndStaleCache } from "./source-cache.js";
import { WildfireSourceError } from "./types.js";

const NOW = "2026-08-12T12:00:00.000Z";

function createContext(entries: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(entries));
  const cache = {
    get: vi.fn(async <T>(key: string) => (values.get(key) as T | undefined) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };

  return { ctx: { cache } as unknown as IntegrationContext, cache };
}

describe("loadWithFreshAndStaleCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a fresh cache hit without loading", async () => {
    const cached = {
      value: { type: "FeatureCollection", features: [] },
      fetchedAt: "2026-08-12T11:00:00.000Z",
    };
    const { ctx, cache } = createContext({ "nifc:viewport:fresh": cached });
    const load = vi.fn(async () => ({ type: "FeatureCollection", features: [{ id: "new" }] }));

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load,
      }),
    ).resolves.toEqual({ ...cached, stale: false });
    expect(load).not.toHaveBeenCalled();
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  it("stores a successful load under both fresh and stale keys", async () => {
    const { ctx, cache } = createContext();
    const result = await loadWithFreshAndStaleCache(ctx, {
      key: "nifc:viewport",
      freshTtlSeconds: 300,
      staleTtlSeconds: 86_400,
      load: vi.fn(async () => ({ type: "FeatureCollection", features: [] })),
    });

    expect(result.value.features).toEqual([]);
    expect(result).toMatchObject({ fetchedAt: NOW, stale: false });
    expect(cache.set).toHaveBeenCalledWith("nifc:viewport:fresh", expect.anything(), 300);
    expect(cache.set).toHaveBeenCalledWith("nifc:viewport:stale", expect.anything(), 86_400);
    expect(cache.set.mock.calls[0][1]).toEqual(cache.set.mock.calls[1][1]);
  });

  it("returns the last successful value as stale when loading fails", async () => {
    const stale = {
      value: { type: "FeatureCollection", features: [{ id: "last-good" }] },
      fetchedAt: "2026-08-12T10:00:00.000Z",
    };
    const { ctx, cache } = createContext({ "nifc:viewport:stale": stale });

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load: async () => {
          throw new Error("upstream unavailable");
        },
      }),
    ).resolves.toEqual({ ...stale, stale: true });
    expect(cache.get).toHaveBeenNthCalledWith(1, "nifc:viewport:fresh");
    expect(cache.get).toHaveBeenNthCalledWith(2, "nifc:viewport:stale");
  });

  it("uses stale data only when an explicit predicate accepts the source failure", async () => {
    const stale = { value: { version: "stale" }, fetchedAt: "2026-08-12T10:00:00.000Z" };
    const error = new WildfireSourceError("NIFC API returned 503", {
      provider: "nifc",
      kind: "upstream-status",
      upstreamStatus: 503,
    });
    const { ctx } = createContext({ "nifc:viewport:stale": stale });

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        shouldUseStaleOnError: (caught) => caught === error,
        load: async () => {
          throw error;
        },
      }),
    ).resolves.toEqual({ ...stale, stale: true });
  });

  it("rethrows a loader failure when its explicit stale predicate rejects it", async () => {
    const stale = { value: { version: "stale" }, fetchedAt: "2026-08-12T10:00:00.000Z" };
    const error = new Error("NIFC API returned 503 while formatting a response");
    const { ctx, cache } = createContext({ "nifc:viewport:stale": stale });

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        shouldUseStaleOnError: () => false,
        load: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  it("rethrows a loader failure when no stale value exists", async () => {
    const { ctx, cache } = createContext();
    const error = new Error("upstream unavailable");

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(cache.get).toHaveBeenNthCalledWith(1, "nifc:viewport:fresh");
    expect(cache.get).toHaveBeenNthCalledWith(2, "nifc:viewport:stale");
  });

  it("shares one loader invocation across concurrent fresh misses for the same key", async () => {
    const { ctx } = createContext();
    let resolveLoad: (value: { version: "fresh" }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ version: "fresh" }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const options = {
      key: "nifc:viewport",
      freshTtlSeconds: 300,
      staleTtlSeconds: 86_400,
      load,
    };

    const first = loadWithFreshAndStaleCache(ctx, options);
    const second = loadWithFreshAndStaleCache(ctx, options);
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
    if (!resolveLoad) throw new Error("loader did not start");
    resolveLoad({ version: "fresh" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: { version: "fresh" }, fetchedAt: NOW, stale: false },
      { value: { version: "fresh" }, fetchedAt: NOW, stale: false },
    ]);
  });

  it("loads concurrent fresh misses for different keys independently", async () => {
    const { ctx } = createContext();
    const firstLoad = vi.fn(async () => ({ source: "nifc" }));
    const secondLoad = vi.fn(async () => ({ source: "firms" }));

    const [first, second] = await Promise.all([
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load: firstLoad,
      }),
      loadWithFreshAndStaleCache(ctx, {
        key: "firms:world",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load: secondLoad,
      }),
    ]);

    expect(first).toMatchObject({ value: { source: "nifc" }, stale: false });
    expect(second).toMatchObject({ value: { source: "firms" }, stale: false });
    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(secondLoad).toHaveBeenCalledTimes(1);
  });

  it("removes a failed shared load so a later request retries", async () => {
    const { ctx } = createContext();
    const error = new Error("upstream unavailable");
    const load = vi
      .fn<() => Promise<{ version: string }>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ version: "retried" });
    const options = {
      key: "nifc:viewport",
      freshTtlSeconds: 300,
      staleTtlSeconds: 86_400,
      load,
    };

    const first = loadWithFreshAndStaleCache(ctx, options);
    const second = loadWithFreshAndStaleCache(ctx, options);

    await expect(Promise.all([first, second])).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(loadWithFreshAndStaleCache(ctx, options)).resolves.toMatchObject({
      value: { version: "retried" },
      stale: false,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("returns fresh data when cache writes fail", async () => {
    const stale = { value: { version: "stale" }, fetchedAt: "2026-08-12T10:00:00.000Z" };
    const cache = {
      get: vi.fn(async <T>(key: string) => (key === "nifc:viewport:stale" ? (stale as T) : null)),
      set: vi.fn(async () => {
        throw new Error("cache unavailable");
      }),
    };
    const ctx = { cache } as unknown as IntegrationContext;

    await expect(
      loadWithFreshAndStaleCache(ctx, {
        key: "nifc:viewport",
        freshTtlSeconds: 300,
        staleTtlSeconds: 86_400,
        load: async () => ({ version: "fresh" }),
      }),
    ).resolves.toEqual({ value: { version: "fresh" }, fetchedAt: NOW, stale: false });
  });
});
