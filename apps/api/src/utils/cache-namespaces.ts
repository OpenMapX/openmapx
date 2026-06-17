/**
 * Cache key-namespace helpers shared with the CLI's `cache list|clear` logic.
 *
 * The grouping + glob-resolution logic mirrors `packages/cli/src/commands/cache.ts`
 * (`aggregateNamespaces` / `resolveCachePattern`). It is copied here rather than
 * imported because `@openmapx/cli` exposes no library entry point (only a `bin`)
 * and pulls in `commander`/docker helpers the API must not depend on. Keep the
 * two in sync: if the app adds a cache prefix, both must learn it.
 */

/**
 * App-owned Redis key prefixes. `int:*` = every integration's `ctx.cache`
 * writes; `cache:*` = the API's own `withCache` keys. The cache admin endpoint
 * only ever scans/clears these prefixes — it must never touch the rest of a
 * (possibly shared) Redis database.
 */
export const APP_CACHE_PREFIXES = ["int:", "cache:"] as const;

/**
 * Turn a `cache clear` target into a Redis key glob. A bare word is treated as
 * an integration namespace (`geocoding` → `int:geocoding:*`); anything already
 * containing a `*` is passed through verbatim.
 */
export function resolveCachePattern(target: string): string {
  return target.includes("*") ? target : `int:${target}:*`;
}

/**
 * Group Redis keys by namespace (everything up to the last `:` segment) with a
 * count each, sorted by count desc then name.
 */
export function aggregateNamespaces(keys: string[]): Array<{ namespace: string; count: number }> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const idx = key.lastIndexOf(":");
    const namespace = idx === -1 ? key : key.slice(0, idx);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

/** True when a resolved glob targets one of the app-owned cache prefixes. */
export function isAppCachePattern(pattern: string): boolean {
  return APP_CACHE_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}
