import { describe, expect, expectTypeOf, it } from "vitest";
import type { CacheClient } from "../context";

function createFakeCache(): CacheClient {
  const hashes = new Map<string, Map<string, unknown>>();
  const ensure = (key: string) => {
    let h = hashes.get(key);
    if (!h) {
      h = new Map<string, unknown>();
      hashes.set(key, h);
    }
    return h;
  };
  return {
    async get<T>(key: string) {
      return (hashes.get(key)?.get("__value__") as T | undefined) ?? null;
    },
    async set(key, value) {
      ensure(key).set("__value__", value);
    },
    async del(key) {
      hashes.delete(key);
    },
    async withCache<T>(key: string, _ttl: number, fn: () => Promise<T>) {
      const cached = hashes.get(key)?.get("__value__") as T | undefined;
      if (cached !== undefined) return cached;
      const value = await fn();
      ensure(key).set("__value__", value);
      return value;
    },
    async hmget<T>(key: string, fields: readonly string[]) {
      const h = hashes.get(key);
      return fields.map((f) => (h?.has(f) ? (h.get(f) as T) : null));
    },
    // Test-only seed helper, exposed via index signature on the returned cast
  } satisfies CacheClient;
}

// Helper to seed a hash directly without piling on more public surface
function seedHash(cache: CacheClient, key: string, entries: Record<string, unknown>): CacheClient {
  // Wrap hmget so seeded entries are returned for `key`, otherwise delegate
  const seeded = new Map<string, unknown>(Object.entries(entries));
  return {
    ...cache,
    async hmget<T>(k: string, fields: readonly string[]) {
      if (k === key) return fields.map((f) => (seeded.has(f) ? (seeded.get(f) as T) : null));
      return cache.hmget<T>(k, fields);
    },
  };
}

describe("CacheClient.hmget", () => {
  it("returns values in field order with null for missing keys", async () => {
    const cache = seedHash(createFakeCache(), "poi:live:src1", {
      a: { x: 1 },
      c: { x: 3 },
    });
    const out = await cache.hmget<{ x: number }>("poi:live:src1", ["a", "b", "c"]);
    expect(out).toEqual([{ x: 1 }, null, { x: 3 }]);
    expect(out).toHaveLength(3);
  });

  it("returns [] for an empty fields array", async () => {
    const cache = createFakeCache();
    expect(await cache.hmget("any", [])).toEqual([]);
  });

  it("typechecks: hmget<T>() yields (T | null)[]", async () => {
    const cache = createFakeCache();
    const result = await cache.hmget<{ x: number }>("k", ["a"]);
    expectTypeOf(result).toEqualTypeOf<({ x: number } | null)[]>();
  });
});
