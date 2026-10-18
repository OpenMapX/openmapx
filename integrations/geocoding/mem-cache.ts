/**
 * In-memory LRU cache with soft/hard TTL for stale-while-revalidate.
 * Sits in front of Redis as L1: sub-millisecond reads for hot queries.
 * Soft TTL: data is "stale" but still served (background refresh triggered).
 * Hard TTL: data is evicted, falls through to Redis / upstream.
 */

import { LRUCache } from "lru-cache";

interface MemEntry<T> {
  data: T;
  softExpiry: number;
  hardExpiry: number;
}

export class MemCache<T> {
  private readonly cache: LRUCache<string, MemEntry<T>>;

  constructor(maxSize: number) {
    this.cache = new LRUCache({ max: maxSize, ttlResolution: 0, perf: { now: () => Date.now() } });
  }

  clear(): void {
    this.cache.clear();
  }

  get(key: string): { data: T; stale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now >= entry.hardExpiry) {
      this.cache.delete(key);
      return null;
    }
    return { data: entry.data, stale: now >= entry.softExpiry };
  }

  set(key: string, data: T, softTtlMs: number, hardTtlMs: number): void {
    const now = Date.now();
    this.cache.set(
      key,
      {
        data,
        softExpiry: now + softTtlMs,
        hardExpiry: now + hardTtlMs,
      },
      { ttl: hardTtlMs },
    );
  }
}
