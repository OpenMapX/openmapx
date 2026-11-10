import type { CacheWriter } from "./cache-writer.js";
import { TTL as TTL_POLICY } from "./policy.js";

// Local structural type that mirrors `CacheClient` from
// `@openmapx/integration-framework`. Inlined here to break a workspace
// dependency cycle: integration-framework now imports types from
// mobility-core (Attribution, MobilityResult) for the canonical provider
// contracts, so mobility-core can no longer depend on integration-framework.
// Any cache instance that satisfies this shape - including the one the host
// passes to integrations via `IntegrationContext.cache` - can be supplied
// directly to the runtime that owns the operation.
export interface CacheClient {
  /** Host administration capability; CLI and test caches may omit it. */
  onInvalidate?(listener: (event: { available: boolean }) => void): () => void;
  /**
   * Managed hosts capture the administrative write fence before acquisition;
   * the returned writer refuses a write once an admin clear has intervened.
   * CLI and test caches may omit it.
   */
  captureWriter?(): Promise<CacheWriter>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Loader signal belongs to the shared cache fill, not any one request. */
  withCache<T>(
    key: string,
    ttlSeconds: number,
    fn: (operationSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T>;
}

export async function cacheGet<T>(cache: CacheClient, key: string): Promise<T | null> {
  return cache.get<T>(key);
}

export { type CacheWriter, captureCacheWriter } from "./cache-writer.js";

export async function withCache<T>(
  cache: CacheClient,
  key: string,
  ttlSeconds: number,
  fn: (operationSignal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  return cache.withCache(key, ttlSeconds, fn, callerSignal);
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
