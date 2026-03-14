import { createHash } from "node:crypto";
import { redis } from "../../redis";

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

export function cacheKey(type: string, params: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(params, Object.keys(params as Record<string, unknown>).sort()))
    .digest("hex")
    .slice(0, 16);
  return `transit:${type}:${hash}`;
}

export const TTL = {
  stops: 3600,
  stop: 3600,
  departures: 60,
  routes: 3600,
  routeGeometry: 86400,
  tripPlan: 300,
  placeStops: 86400, // 24h — linked stops rarely change
  placeRoutes: 300, // 5min — routes are semi-stable
  placeAlerts: 60, // 1min — alerts are time-sensitive
  placeFacilities: 86400, // 24h — facilities rarely change
} as const;
