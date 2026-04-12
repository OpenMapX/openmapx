import type { CacheClient } from "@openmapx/core";

let _cache: CacheClient | null = null;

export function initCache(cache: CacheClient): void {
  _cache = cache;
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
