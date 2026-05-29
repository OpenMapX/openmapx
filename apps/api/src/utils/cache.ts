import { createHash } from "node:crypto";
import { TTL as TTL_POLICY } from "@openmapx/mobility-core/policy";
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

// Centralized TTL constants

export const TTL = {
  transit: {
    stops: TTL_POLICY.SCHEDULE,
    stop: TTL_POLICY.SCHEDULE,
    stopSearch: TTL_POLICY.SCHEDULE,
    departures: TTL_POLICY.REALTIME_WARM,
    arrivals: TTL_POLICY.REALTIME_WARM,
    routes: TTL_POLICY.SCHEDULE,
    routeStops: TTL_POLICY.SCHEDULE,
    routeGeometry: TTL_POLICY.STATIC_ARCHIVE,
    tripPlan: TTL_POLICY.SHORT_LIVED,
    placeStops: TTL_POLICY.PLACE_LINK,
    placeRoutes: TTL_POLICY.SHORT_LIVED,
    placeAlerts: TTL_POLICY.REALTIME_WARM,
    placeFacilities: TTL_POLICY.STATIC_ARCHIVE,
    // vehicles/radar: behavior change 15 → 30s (REALTIME_HOT). Authorized by A4 plan.
    vehicles: TTL_POLICY.REALTIME_HOT,
    vehicleJourney: TTL_POLICY.REALTIME_HOT,
    radar: TTL_POLICY.REALTIME_HOT,
    facilities: TTL_POLICY.SHORT_LIVED,
    alerts: TTL_POLICY.REALTIME_WARM,
    registry: TTL_POLICY.CATALOG_REFRESH,
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
  category: TTL_POLICY.CATEGORY_SEARCH,
  dataSources: {
    filters: TTL_POLICY.CATALOG_REFRESH,
    search: TTL_POLICY.REFERENCE_DATA,
    detail: TTL_POLICY.REFERENCE_DATA,
    evReference: TTL_POLICY.CATALOG_REFRESH,
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
  winterSports: TTL_POLICY.REFERENCE_DATA,
  elevation: 86400,
  hiking: {
    search: 1800,
    area: 1800,
    detail: 86400,
    geometry: 86400,
    shelters: TTL_POLICY.REFERENCE_DATA,
  },
  photos: 3600,
  sharedMobility: {
    catalog: TTL_POLICY.STATIC_ARCHIVE,
    networks: TTL_POLICY.SCHEDULE,
    stations: TTL_POLICY.VEHICLE_STATUS,
  },
  weather: {
    current: 900,
    forecast: 1800,
  },
} as const;
