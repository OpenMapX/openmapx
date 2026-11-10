import type { CacheClient } from "./context";

/** Writes cache entries under the administrative fence captured when it was created. */
export type CacheWriter = Pick<CacheClient, "set">;

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
export async function captureCacheWriter(
  cache: Pick<CacheClient, "set" | "captureWriter">,
): Promise<CacheWriter> {
  if (!cache.captureWriter) return cache;
  try {
    return await cache.captureWriter();
  } catch {
    return skipWrites;
  }
}
