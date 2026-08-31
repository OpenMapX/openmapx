export const APP_CACHE_PREFIXES = ["int:", "cache:"] as const;

export function isAppCachePattern(pattern: string): boolean {
  return APP_CACHE_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}
