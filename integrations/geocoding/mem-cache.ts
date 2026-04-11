/**
 * In-memory LRU cache with soft/hard TTL for stale-while-revalidate.
 * Sits in front of Redis as L1: sub-millisecond reads for hot queries.
 * Soft TTL: data is "stale" but still served (background refresh triggered).
 * Hard TTL: data is evicted, falls through to Redis / upstream.
 */

interface MemEntry<T> {
  data: T;
  softExpiry: number;
  hardExpiry: number;
}

export class MemCache<T> {
  private cache = new Map<string, MemEntry<T>>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): { data: T; stale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now > entry.hardExpiry) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { data: entry.data, stale: now > entry.softExpiry };
  }

  set(key: string, data: T, softTtlMs: number, hardTtlMs: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const now = Date.now();
    this.cache.set(key, {
      data,
      softExpiry: now + softTtlMs,
      hardExpiry: now + hardTtlMs,
    });
  }
}
