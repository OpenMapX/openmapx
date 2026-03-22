import { createHash } from "node:crypto";
import { redis } from "../redis.js";

// Types

export type CacheStatus = "HIT" | "MISS" | "STALE";

export interface CacheResult<T> {
  data: T;
  status: CacheStatus;
}

// Low-level primitives

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Redis unavailable — proceed without caching
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // Silent
  }
}

// Cache-or-fetch with status + optional stale-on-error

const inflight = new Map<string, Promise<unknown>>();

export async function withCacheStatus<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts?: { staleOnError?: boolean },
): Promise<CacheResult<T>> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return { data: cached, status: "HIT" };
  }

  // Coalesce concurrent misses for the same key
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) {
    try {
      return { data: await existing, status: "MISS" };
    } catch (err) {
      if (opts?.staleOnError) {
        const stale = await cacheGet<T>(`stale:${key}`);
        if (stale !== null) return { data: stale, status: "STALE" };
      }
      throw err;
    }
  }

  const promise = (async () => {
    const result = await fn();
    await cacheSet(key, result, ttlSeconds);
    if (opts?.staleOnError) {
      await cacheSet(`stale:${key}`, result, ttlSeconds * 3);
    }
    return result;
  })();

  inflight.set(key, promise);

  try {
    const data = await promise;
    return { data, status: "MISS" };
  } catch (err) {
    if (opts?.staleOnError) {
      const stale = await cacheGet<T>(`stale:${key}`);
      if (stale !== null) {
        return { data: stale, status: "STALE" };
      }
    }
    throw err;
  } finally {
    inflight.delete(key);
  }
}

// Simple cache-or-fetch (returns T directly)

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const { data } = await withCacheStatus(key, ttlSeconds, fn);
  return data;
}

// Key building

export function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

// Coordinate rounding for cache key stability

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// In-memory LRU cache with soft/hard TTL for stale-while-revalidate
// Sits in front of Redis as L1: sub-millisecond reads for hot queries.
// Soft TTL: data is "stale" but still served (background refresh triggered).
// Hard TTL: data is evicted, falls through to Redis / upstream.

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

// Centralized TTL constants

export const TTL = {
  transit: {
    stops: 3600,
    stop: 3600,
    stopSearch: 3600,
    departures: 60,
    arrivals: 60,
    routes: 3600,
    routeStops: 3600,
    routeGeometry: 86400,
    tripPlan: 300,
    placeStops: 86400,
    placeRoutes: 300,
    placeAlerts: 60,
    placeFacilities: 86400,
    vehicles: 15,
    vehicleJourney: 30,
    radar: 15,
    facilities: 300,
    alerts: 60,
    registry: 172800,
  },
  geocoding: {
    forward: 86400,
    reverse: 86400,
    autocomplete: 3600,
  },
  places: {
    detail: 86400,
  },
  directions: 3600,
  isochrone: 3600,
  category: 1800,
  dataSources: {
    filters: 172800,
    search: 21600,
    detail: 21600,
    evReference: 172800,
  },
  airQuality: {
    station: 3600,
    location: 3600,
  },
  earthquakes: {
    hour: 60,
    day: 120,
    week: 300,
    month: 600,
  },
  wildfires: {
    1: 300,
    2: 600,
    3: 900,
  },
  winterSports: 21600,
  elevation: 86400,
  hiking: {
    search: 1800,
    area: 1800,
    detail: 86400,
    geometry: 86400,
    shelters: 21600,
  },
  photos: 3600,
  sharedMobility: {
    catalog: 86400,
    networks: 3600,
    stations: 120,
  },
} as const;
