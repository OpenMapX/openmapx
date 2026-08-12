import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWithFreshAndStaleCache } from "./source-cache.js";

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
});
