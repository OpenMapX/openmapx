/** Writes cache entries under the administrative fence captured when it was created. */
export interface CacheWriter {
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}

/** The part of a cache client that writing under a fence needs. */
export interface FencedCacheTarget extends CacheWriter {
  /**
   * Managed hosts capture the administrative write fence before acquisition;
   * the returned writer refuses a write once an admin clear has intervened.
   * CLI and test caches may omit it.
   */
  captureWriter?(): Promise<CacheWriter>;
}

const skipWrites: CacheWriter = { set: async () => undefined };

/**
 * Capture the cache's administrative write fence before an upstream request,
 * then store what the request returned through the writer it gives. A write
 * that lands after an admin cache clear is refused, so a request that began
 * before the clear cannot refill the namespace.
 *
 * Hosts without shared cache administration (CLI and test fixtures) have no
 * fence to capture; their cache writes directly. A host whose capture fails
 * gets a writer that stores nothing: the fence is never recaptured after the
 * request.
 */
export async function captureCacheWriter(cache: FencedCacheTarget): Promise<CacheWriter> {
  if (!cache.captureWriter) return cache;
  try {
    return await cache.captureWriter();
  } catch {
    return skipWrites;
  }
}
