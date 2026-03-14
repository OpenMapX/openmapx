import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../redis.js", () => ({ redis: null }));

describe("withCache", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls fn() when redis is null and returns result", async () => {
    const { withCache } = await import("../cache.js");
    const fn = vi.fn().mockResolvedValue({ data: 42 });
    const result = await withCache("key", 60, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toEqual({ data: 42 });
  });

  it("returns cached value on hit without calling fn()", async () => {
    const store = new Map<string, string>();
    store.set("hit-key", JSON.stringify({ data: "cached" }));
    const mockRedis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(),
    };
    vi.doMock("../../redis.js", () => ({ redis: mockRedis }));
    const { withCache } = await import("../cache.js");
    const fn = vi.fn();
    const result = await withCache("hit-key", 60, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual({ data: "cached" });
  });

  it("calls fn() and writes to cache on miss", async () => {
    const store = new Map<string, string>();
    const mockRedis = {
      get: vi.fn(async () => null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    };
    vi.doMock("../../redis.js", () => ({ redis: mockRedis }));
    const { withCache } = await import("../cache.js");
    const fn = vi.fn().mockResolvedValue({ data: "fresh" });
    const result = await withCache("miss-key", 300, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toEqual({ data: "fresh" });
    expect(mockRedis.set).toHaveBeenCalledWith(
      "miss-key",
      JSON.stringify({ data: "fresh" }),
      "EX",
      300,
    );
  });

  it("falls through to fn() when Redis.get() throws", async () => {
    const mockRedis = {
      get: vi.fn().mockRejectedValue(new Error("connection refused")),
      set: vi.fn(),
    };
    vi.doMock("../../redis.js", () => ({ redis: mockRedis }));
    const { withCache } = await import("../cache.js");
    const fn = vi.fn().mockResolvedValue({ data: "fallback" });
    const result = await withCache("err-key", 60, fn);
    expect(result).toEqual({ data: "fallback" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("returns fn() result even when cache write throws", async () => {
    const mockRedis = {
      get: vi.fn(async () => null),
      set: vi.fn().mockRejectedValue(new Error("write error")),
    };
    vi.doMock("../../redis.js", () => ({ redis: mockRedis }));
    const { withCache } = await import("../cache.js");
    const fn = vi.fn().mockResolvedValue({ data: "ok" });
    const result = await withCache("write-err-key", 60, fn);
    expect(result).toEqual({ data: "ok" });
  });
});

describe("hashKey", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("produces deterministic 16-char hex suffix", async () => {
    const { hashKey } = await import("../cache.js");
    const k1 = hashKey("cache:geocode", "Berlin");
    const k2 = hashKey("cache:geocode", "Berlin");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^cache:geocode:[a-f0-9]{16}$/);
  });

  it("produces different keys for different data", async () => {
    const { hashKey } = await import("../cache.js");
    expect(hashKey("cache:geocode", "Berlin")).not.toBe(hashKey("cache:geocode", "Munich"));
  });

  it("produces different keys for different prefixes", async () => {
    const { hashKey } = await import("../cache.js");
    expect(hashKey("cache:geocode", "x")).not.toBe(hashKey("cache:autocomplete", "x"));
  });
});

describe("round", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rounds to 4 decimal places", async () => {
    const { round } = await import("../cache.js");
    expect(round(52.123456789, 4)).toBe(52.1235);
  });

  it("rounds to 2 decimal places", async () => {
    const { round } = await import("../cache.js");
    expect(round(13.405678, 2)).toBe(13.41);
  });
});
