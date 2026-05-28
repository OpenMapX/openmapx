"use client";

export const RECENT_MAP_DATA_CACHE_ENABLED_KEY = "openmapx-recent-map-data-cache-enabled";
export const QUERY_CACHE_KEY = "openmapx-query-cache";

export const RECENT_MAP_DATA_CACHE_NAMES = [
  "api-geodata",
  "api-category-search",
  "api-autocomplete",
  "api-weather",
  "api-photos",
] as const;

const RECENT_MAP_DATA_QUERY_KEY_ROOTS = new Set([
  "place",
  "weather",
  "isochrone",
  "sun-times",
  "directions",
  "route",
  "geocode",
]);

const SERVICE_WORKER_MESSAGE_TYPE = "SET_RECENT_MAP_DATA_CACHE_ENABLED";

function postRecentMapDataCachePreference(enabled: boolean): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  const message = { type: SERVICE_WORKER_MESSAGE_TYPE, enabled };
  navigator.serviceWorker.controller?.postMessage(message);

  void navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage(message);
      registration.waiting?.postMessage(message);
      registration.installing?.postMessage(message);
    })
    .catch(() => {
      // Service worker support is optional for this preference.
    });
}

export function isRecentMapDataCacheEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY) === "true";
}

export function syncRecentMapDataCachePreference(): void {
  postRecentMapDataCachePreference(isRecentMapDataCacheEnabled());
}

export function isRecentMapDataQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && RECENT_MAP_DATA_QUERY_KEY_ROOTS.has(root);
}

export async function clearRecentMapDataCache(): Promise<void> {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(QUERY_CACHE_KEY);
  }

  if (typeof caches !== "undefined") {
    await Promise.all(RECENT_MAP_DATA_CACHE_NAMES.map((name) => caches.delete(name)));
  }

  postRecentMapDataCachePreference(isRecentMapDataCacheEnabled());
}

export async function setRecentMapDataCacheEnabled(enabled: boolean): Promise<void> {
  if (typeof window === "undefined") return;

  if (enabled) {
    window.localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true");
  } else {
    window.localStorage.removeItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY);
  }

  postRecentMapDataCachePreference(enabled);

  if (!enabled) {
    await clearRecentMapDataCache();
  }
}

export async function enforceRecentMapDataCachePreference(): Promise<void> {
  const enabled = isRecentMapDataCacheEnabled();
  postRecentMapDataCachePreference(enabled);

  if (!enabled) {
    await clearRecentMapDataCache();
  }
}

export function getStoredQueryCacheBytes(): number {
  if (typeof window === "undefined") return 0;

  const value = window.localStorage.getItem(QUERY_CACHE_KEY);
  if (!value) return 0;

  if (typeof Blob !== "undefined") {
    return new Blob([value]).size;
  }

  return value.length;
}
