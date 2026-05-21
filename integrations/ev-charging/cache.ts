import type { CacheClient } from "@openmapx/integration-framework";

let _cache: CacheClient | null = null;

export function initCache(cache: CacheClient): void {
  _cache = cache;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  return _cache?.get<T>(key) ?? null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await _cache?.set(key, value, ttlSeconds);
}

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (_cache) {
    const cached = await _cache.get<T>(key);
    if (cached !== null) return cached;
  }
  const result = await fn();
  await _cache?.set(key, result, ttlSeconds);
  return result;
}

export const TTL = {
  dataSources: {
    evReference: 172_800,
  },
};
