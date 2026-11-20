import type { CacheWriter } from "./cache-writer.js";
import { TTL as TTL_POLICY } from "./policy.js";

/**
 * The cache an integration receives as `IntegrationContext.cache`, and the one
 * every runtime that caches provider data takes. The integration framework
 * re-exports this type; it lives here because the framework depends on
 * mobility-core, not the other way round.
 */
export interface CacheClient {
  /**
   * Host administration events; immediately reports current availability.
   * Clear local copies on every event and bypass them while unavailable.
   * Absent in clients without host administration (for example CLI fixtures).
   */
  onInvalidate?(listener: (event: { available: boolean }) => void): () => void;
  /**
   * Managed shared caches can capture an administrative write fence before
   * acquisition. Use this writer for additional derived entries after awaits;
   * late writes are rejected when the captured Redis invalidation epoch changes.
   * Also guard local state/lifetime with onInvalidate and disposal; this writer
   * is not a subscriber-availability or linearizable cross-worker read barrier.
   * Hosts without shared cache administration omit this capability.
   */
  captureWriter?(): Promise<CacheWriter>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Coalesce equal cache misses. The loader receives the shared operation
   * signal; `callerSignal` cancels only that caller, and shared work is aborted
   * once no callers remain. `shouldCache` can keep a useful but degraded
   * fulfilled value out of the shared cache.
   */
  withCache<T>(
    key: string,
    ttlSeconds: number,
    fn: (operationSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    shouldCache?: (value: T) => boolean,
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
  shouldCache?: (value: T) => boolean,
): Promise<T> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  return cache.withCache(key, ttlSeconds, fn, callerSignal, shouldCache);
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
