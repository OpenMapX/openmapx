import { TTL as TTL_POLICY } from "./policy.js";

// Local structural type that mirrors `CacheClient` from
// `@openmapx/integration-framework`. Inlined here to break a workspace
// dependency cycle: integration-framework now imports types from
// mobility-core (Attribution, MobilityResult) for the canonical provider
// contracts, so mobility-core can no longer depend on integration-framework.
// Any cache instance that satisfies this shape - including the one the host
// passes to integrations via `IntegrationContext.cache` - can be supplied
// to `initCache()`.
interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  withCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T>;
}

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
  sharedMobility: {
    catalog: TTL_POLICY.STATIC_ARCHIVE,
    // Policy says VEHICLE_STATUS (120s) for GBFS station_status, but the
    // integration layer caches at SHORT_LIVED (5 min) to amortise upstream
    // load on catalog probes. Revisit when the orchestrator drives polling
    // cadence independently of cache TTL.
    stations: TTL_POLICY.SHORT_LIVED,
    networks: TTL_POLICY.SHORT_LIVED,
    citybikes: TTL_POLICY.SHORT_LIVED,
    nextbike: TTL_POLICY.SHORT_LIVED,
  },
};
