import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock redis before importing cache module
vi.mock("../../../redis.js", () => ({
  redis: null,
}));

describe("cache utilities", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("cacheKey", () => {
    it("produces deterministic hash-based keys", async () => {
      const { cacheKey } = await import("../cache.js");
      const key1 = cacheKey("stops", { lat: 52.52, lng: 13.405 });
      const key2 = cacheKey("stops", { lat: 52.52, lng: 13.405 });
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^transit:stops:[a-f0-9]{16}$/);
    });

    it("produces different keys for different params", async () => {
      const { cacheKey } = await import("../cache.js");
      const key1 = cacheKey("stops", { lat: 52.52, lng: 13.405 });
      const key2 = cacheKey("stops", { lat: 48.14, lng: 11.56 });
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different types", async () => {
      const { cacheKey } = await import("../cache.js");
      const key1 = cacheKey("stops", { lat: 52.52 });
      const key2 = cacheKey("departures", { lat: 52.52 });
      expect(key1).not.toBe(key2);
    });
  });

  describe("TTL constants", () => {
    it("exports expected TTL values", async () => {
      const { TTL } = await import("../cache.js");
      expect(TTL.stops).toBe(3600);
      expect(TTL.departures).toBe(60);
      expect(TTL.routeGeometry).toBe(86400);
      expect(TTL.tripPlan).toBe(300);
    });
  });

  describe("cacheGet with null redis", () => {
    it("returns null when redis is not available", async () => {
      const { cacheGet } = await import("../cache.js");
      const result = await cacheGet("any-key");
      expect(result).toBeNull();
    });
  });

  describe("cacheSet with null redis", () => {
    it("does nothing when redis is not available", async () => {
      const { cacheSet } = await import("../cache.js");
      // Should not throw
      await expect(cacheSet("key", { data: 1 }, 60)).resolves.toBeUndefined();
    });
  });

  describe("cacheGet/cacheSet with mocked redis", () => {
    it("round-trips data through redis", async () => {
      const store = new Map<string, { value: string; ttl: number }>();
      const mockRedis = {
        get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
        set: vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
          store.set(key, { value, ttl });
        }),
      };

      vi.doMock("../../../redis.js", () => ({ redis: mockRedis }));
      const { cacheGet, cacheSet } = await import("../cache.js");

      await cacheSet("test-key", { hello: "world" }, 300);
      expect(mockRedis.set).toHaveBeenCalledWith(
        "test-key",
        JSON.stringify({ hello: "world" }),
        "EX",
        300,
      );

      const result = await cacheGet<{ hello: string }>("test-key");
      expect(result).toEqual({ hello: "world" });
    });
  });
});
