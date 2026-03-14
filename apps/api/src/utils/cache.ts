import { createHash } from "node:crypto";
import { redis } from "../redis.js";

/**
 * Wraps an async function with Redis caching.
 * Falls through transparently on Redis unavailability or errors.
 * NOTE: All Redis calls are wrapped in try/catch because ioredis is configured
 * with enableOfflineQueue: false — dropped connections throw immediately.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch {
      // Redis read error — fall through to fn()
    }
  }

  const result = await fn();

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(result), "EX", ttlSeconds);
    } catch {
      // Cache write failure is silent — caller still gets the result
    }
  }

  return result;
}

/**
 * Builds a namespaced Redis key by hashing arbitrary data.
 * Uses 16 hex chars of SHA-256 — consistent with the transit cache convention.
 */
export function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

/** Round a float to the given number of decimal places. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
