import { describe, expect, it } from "vitest";
import { captureCacheWriter } from "./cache-writer";
import { createFencedMemoryCache, createPassthroughCache } from "./testing";

describe("captureCacheWriter", () => {
  it("refuses a write that lands after a clear during the upstream request", async () => {
    const cache = createFencedMemoryCache();
    let finishUpstream!: (value: string) => void;
    const upstream = new Promise<string>((resolve) => {
      finishUpstream = resolve;
    });
    const acquisition = (async () => {
      const writer = await captureCacheWriter(cache);
      await writer.set("result", await upstream, 60);
    })();

    cache.clear();
    finishUpstream("from before the clear");
    await acquisition;

    expect(cache.values.has("result")).toBe(false);
  });

  it("is needed because a direct set after the request refills a cleared cache", async () => {
    const cache = createFencedMemoryCache();
    let finishUpstream!: (value: string) => void;
    const upstream = new Promise<string>((resolve) => {
      finishUpstream = resolve;
    });
    const acquisition = (async () => {
      await cache.set("result", await upstream, 60);
    })();

    cache.clear();
    finishUpstream("from before the clear");
    await acquisition;

    expect(cache.values.get("result")).toBe("from before the clear");
  });

  it("stores the entry with its TTL when no clear intervenes", async () => {
    const cache = createFencedMemoryCache();
    const writer = await captureCacheWriter(cache);
    await writer.set("result", { found: true }, 90);
    expect(cache.values.get("result")).toEqual({ found: true });
    expect(cache.ttls.get("result")).toBe(90);
  });

  it("writes directly when the host has no administrative fence", async () => {
    const written: unknown[] = [];
    const cache = createPassthroughCache();
    cache.set = async (key, value, ttl) => {
      written.push([key, value, ttl]);
    };
    const writer = await captureCacheWriter(cache);
    await writer.set("result", 1, 30);
    expect(written).toEqual([["result", 1, 30]]);
  });

  it("stores nothing when the fence cannot be captured", async () => {
    const cache = createFencedMemoryCache();
    cache.captureWriter = async () => {
      throw new Error("Redis unavailable");
    };
    const writer = await captureCacheWriter(cache);
    await writer.set("result", 1, 30);
    expect(cache.values.size).toBe(0);
  });
});
