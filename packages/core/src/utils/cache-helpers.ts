import type { CacheClient } from "../integration/context";

/**
 * Cache-or-fetch: returns cached value if present, else calls fn(), caches result, returns it.
 * Works with any CacheClient implementation (Redis, in-memory, etc.).
 */
export async function withCache<T>(
  cache: CacheClient,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await cache.get<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  await cache.set(key, result, ttlSeconds);
  return result;
}
