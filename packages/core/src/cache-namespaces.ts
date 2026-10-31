export interface CacheNamespaceCount {
  namespace: string;
  count: number;
}

export function resolveCachePattern(target: string): string {
  return target.includes("*") ? target : `int:${target}:*`;
}

export function aggregateCacheNamespaces(keys: readonly string[]): CacheNamespaceCount[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const separator = key.lastIndexOf(":");
    const namespace = separator === -1 ? key : key.slice(0, separator);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

/** Web cache operations remain confined to these literal application prefixes. */
export const APP_CACHE_PREFIXES = ["int:", "cache:"] as const;
export function isSafeCacheTargetText(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}
export function isAppCachePattern(pattern: string): boolean {
  return (
    isSafeCacheTargetText(pattern) &&
    APP_CACHE_PREFIXES.some((prefix) => pattern.startsWith(prefix))
  );
}
