// Build pipeline note:
// We bundle this file with esbuild (`pnpm build:sw`) instead of using
// `withSerwist` in next.config.ts. Why:
//   * `@serwist/next/worker` exports `defaultCache` (used below); we still
//     consume `serwist` and `@serwist/next` directly, so they stay deps.
//   * `withSerwist` has not been validated against Next 16 + Turbopack here,
//     and the standalone-output copy step in `pnpm build` is custom too.
//   * Custom esbuild also gives us a single, hand-managed sw.js — handy for
//     reasoning about cache behavior without an injected build manifest.
// Trade-off: precaching is hand-rolled. We use a custom `install` event to
// pre-cache the offline page + manifest into APP_SHELL_CACHE, which is enough
// for the goals (offline fallback, installable). The Next build manifest is
// not auto-precached; runtime caches handle everything else lazily.
import { defaultCache } from "@serwist/next/worker";
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  type RouteHandlerCallback,
  type RouteHandlerCallbackOptions,
  Serwist,
  StaleWhileRevalidate,
  type Strategy,
} from "serwist";

declare const self: ServiceWorkerGlobalScope;

const OFFLINE_URL = "/offline";
const HOME_URL = "/";
const APP_SHELL_CACHE = "app-shell-v1";
// `/` is precached so a user with downloaded offline areas can still reach
// the map after the runtime `pages` cache has expired (24h / 20 entries).
// Without this, the nav handler would fall through to /offline and the
// downloaded tiles would be unreachable.
const APP_SHELL_URLS = [HOME_URL, OFFLINE_URL, "/manifest.webmanifest"];
const OFFLINE_AREA_CACHE_PREFIX = "offline-area-";
const RECENT_MAP_DATA_CACHE_NAMES = [
  "api-geodata",
  "api-category-search",
  "api-autocomplete",
  "api-weather",
  "api-photos",
] as const;
const RECENT_MAP_DATA_CACHE_PREFERENCE_CACHE = "openmapx-preferences";
const RECENT_MAP_DATA_CACHE_PREFERENCE_URL = "/__openmapx/recent-map-data-cache-enabled";

let recentMapDataCacheEnabled: boolean | null = null;

function clearRecentMapDataRuntimeCaches(): Promise<boolean[]> {
  return Promise.all(RECENT_MAP_DATA_CACHE_NAMES.map((name) => caches.delete(name)));
}

async function readRecentMapDataCachePreference(): Promise<boolean> {
  if (recentMapDataCacheEnabled !== null) return recentMapDataCacheEnabled;

  if (!(await caches.has(RECENT_MAP_DATA_CACHE_PREFERENCE_CACHE))) {
    recentMapDataCacheEnabled = false;
    return false;
  }

  const cache = await caches.open(RECENT_MAP_DATA_CACHE_PREFERENCE_CACHE);
  const response = await cache.match(RECENT_MAP_DATA_CACHE_PREFERENCE_URL);
  recentMapDataCacheEnabled = response ? (await response.text()) === "true" : false;
  return recentMapDataCacheEnabled;
}

async function writeRecentMapDataCachePreference(enabled: boolean): Promise<void> {
  recentMapDataCacheEnabled = enabled;

  if (enabled) {
    const cache = await caches.open(RECENT_MAP_DATA_CACHE_PREFERENCE_CACHE);
    await cache.put(RECENT_MAP_DATA_CACHE_PREFERENCE_URL, new Response("true"));
    return;
  }

  await Promise.all([
    caches.delete(RECENT_MAP_DATA_CACHE_PREFERENCE_CACHE),
    clearRecentMapDataRuntimeCaches(),
  ]);
}

/**
 * Looks up a request in any user-downloaded offline-area cache. Used by tile
 * and style handlers so a user-pinned area is served instantly and works
 * offline even after the runtime caches expire or are cleared.
 */
async function matchOfflineArea(request: Request): Promise<Response | null> {
  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    if (!name.startsWith(OFFLINE_AREA_CACHE_PREFIX)) continue;
    const cache = await caches.open(name);
    const match = await cache.match(request, { ignoreSearch: false });
    if (match) return match;
  }
  return null;
}

/**
 * Wraps a Serwist strategy so user-downloaded offline-area caches are checked
 * first. Anything cached as part of a downloaded area should be served
 * immediately; only on miss do we fall through to the runtime strategy. This
 * keeps a downloaded area usable across runtime cache evictions, theme
 * changes, and self-hosted style deployments.
 */
function withOfflineFirst(strategy: Strategy): RouteHandlerCallback {
  return async (options: RouteHandlerCallbackOptions) => {
    const offlineMatch = await matchOfflineArea(options.request);
    if (offlineMatch) return offlineMatch;
    return strategy.handle(options);
  };
}

function withRecentMapDataCache(strategy: Strategy): RouteHandlerCallback {
  return async (options: RouteHandlerCallbackOptions) => {
    if (!(await readRecentMapDataCachePreference())) {
      return fetch(options.request);
    }

    return strategy.handle(options);
  };
}

// Navigation handler: NetworkFirst with offline fallback.
// If both network (within timeout) and cache miss, serve precached /offline.
const navigationStrategy = new NetworkFirst({
  cacheName: "pages",
  networkTimeoutSeconds: 3,
  plugins: [new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 })],
});

const serwist = new Serwist({
  precacheEntries: [],
  // Don't auto-skip-waiting. The client surfaces an "Update available" prompt
  // and posts SKIP_WAITING when the user accepts the reload.
  skipWaiting: false,
  clientsClaim: true,
  // Navigation preload is DISABLED on purpose. With it enabled, Firefox (incl.
  // Firefox Android) surfaces the *failed* preload network request as the
  // navigation result when offline — even though this SW answers from cache via
  // respondWith — so an installed PWA shows the browser's "Unable to connect" /
  // "Address not found" page on cold launch instead of the cached app. It only
  // bites top-level navigations (launch/reload), which is why warm in-app use
  // works but a cold reopen doesn't, and why reloading doesn't help. Chromium
  // handles preload correctly (Brave/Chrome launch offline fine), but for
  // offline parity on Firefox we forgo the preload optimization entirely.
  // See https://github.com/GoogleChrome/workbox/issues/3134.
  navigationPreload: false,
  runtimeCaching: [
    // Auth — never cache. Always go to network. Failures must surface to UI.
    {
      matcher: /\/api\/auth\//,
      handler: ({ request }: { request: Request }) => fetch(request),
    },

    // Next.js static assets — CacheFirst (immutable, build-hash versioned)
    {
      matcher: /^\/_next\/static\/.*/i,
      handler: new CacheFirst({
        cacheName: "static-assets",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },

    // MapTiler tiles / style / sprite / glyphs via API proxy — offline-area first, then SWR.
    {
      matcher: /\/api\/maptiler\//i,
      handler: withOfflineFirst(
        new StaleWhileRevalidate({
          cacheName: "map-tiles",
          plugins: [new ExpirationPlugin({ maxEntries: 1000, maxAgeSeconds: 7 * 24 * 60 * 60 })],
        }),
      ),
    },

    // Mapillary coverage tiles via API proxy — StaleWhileRevalidate
    {
      matcher: /\/api\/mapillary\/tiles\//i,
      handler: new StaleWhileRevalidate({
        cacheName: "mapillary-tiles",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 3 * 24 * 60 * 60 })],
      }),
    },

    // Self-hosted map style assets — covers `/styles/*` for the same-origin
    // openmapx style as well as for any `NEXT_PUBLIC_MAP_STYLE_URL` base
    // whose path is also `/styles/*`. Style JSON, sprite JSON/PNG, and
    // TileJSON live here. Offline-area entries are served first so a
    // downloaded area renders even when the runtime cache has been cleared.
    {
      matcher: ({ url }: { url: URL }) => /\/styles\//i.test(url.pathname),
      handler: withOfflineFirst(
        new StaleWhileRevalidate({
          cacheName: "style-assets",
          plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 })],
        }),
      ),
    },

    // API geodata — StaleWhileRevalidate
    // Covers: /api/integrations/geocoding/geocode, /api/integrations/routing/directions, /api/places/:id
    // Excludes: /api/places/search (category search embeds live fuel prices)
    {
      matcher: ({ url }: { url: URL }) =>
        /\/api\/integrations\/(geocoding\/geocode|routing\/directions)/.test(url.pathname) ||
        (/\/api\/places\//.test(url.pathname) && !url.pathname.includes("/places/search")),
      handler: withRecentMapDataCache(
        new StaleWhileRevalidate({
          cacheName: "api-geodata",
          plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 24 * 60 * 60 })],
        }),
      ),
    },

    // Category search — NetworkFirst (contains live fuel prices)
    {
      matcher: /\/api\/places\/search/,
      handler: withRecentMapDataCache(
        new NetworkFirst({
          cacheName: "api-category-search",
          networkTimeoutSeconds: 5,
          plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 })],
        }),
      ),
    },

    // Autocomplete — NetworkFirst (fresh suggestions always preferred)
    {
      matcher: /\/api\/integrations\/geocoding\/autocomplete/,
      handler: withRecentMapDataCache(
        new NetworkFirst({
          cacheName: "api-autocomplete",
          networkTimeoutSeconds: 3,
          plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 })],
        }),
      ),
    },

    // Weather — StaleWhileRevalidate (conditions change slowly)
    {
      matcher: /\/api\/integrations\/weather\//,
      handler: withRecentMapDataCache(
        new StaleWhileRevalidate({
          cacheName: "api-weather",
          plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 60 })],
        }),
      ),
    },

    // Photos — StaleWhileRevalidate (photo results are stable)
    {
      matcher: /\/api\/integrations\/photos\//,
      handler: withRecentMapDataCache(
        new StaleWhileRevalidate({
          cacheName: "api-photos",
          plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 })],
        }),
      ),
    },

    // Self-hosted vector tiles & font glyphs (.pbf) — offline-area first,
    // then CacheFirst.
    {
      matcher: /\.pbf(\?.*)?$/i,
      handler: withOfflineFirst(
        new CacheFirst({
          cacheName: "vector-tiles",
          plugins: [new ExpirationPlugin({ maxEntries: 5000, maxAgeSeconds: 30 * 24 * 60 * 60 })],
        }),
      ),
    },

    // App shell HTML — NetworkFirst, with offline fallback in setCatchHandler.
    {
      matcher: ({ request }: { request: Request }) => request.mode === "navigate",
      handler: async (options) => {
        try {
          const response = await navigationStrategy.handle(options);
          if (response) return response;
          throw new Error("Empty response from navigation strategy");
        } catch (err) {
          // Both network and runtime cache missed. Try the URL itself in the
          // app-shell cache first (e.g. `/` was precached at install time, so
          // a user with downloaded offline areas can still reach the map even
          // after the runtime `pages` entry has expired). Only fall back to
          // the offline page if the URL isn't in app-shell either.
          const cache = await caches.open(APP_SHELL_CACHE);
          const exact = await cache.match(options.request, { ignoreSearch: true });
          if (exact) return exact;
          const fallback = await cache.match(OFFLINE_URL);
          if (fallback) return fallback;
          throw err;
        }
      },
    },

    ...defaultCache,
  ],
});

// Precache the offline page + manifest at install time so a cold-start while
// offline still renders something useful. We don't use Serwist's precacheEntries
// because the custom esbuild build pipeline doesn't inject the build manifest.
//
// Per-URL via Promise.allSettled rather than `cache.addAll` because addAll is
// atomic — if /manifest.webmanifest happens to be unavailable, /offline would
// otherwise not get cached either, breaking the navigation fallback.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      await Promise.allSettled(
        APP_SHELL_URLS.map(async (url) => {
          const response = await fetch(url, { cache: "reload" });
          if (response.ok) await cache.put(url, response);
        }),
      );
    }),
  );
});

// Allow the page to trigger skipWaiting — gates SW updates behind a user
// confirmation in the UI.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data?.type === "SET_RECENT_MAP_DATA_CACHE_ENABLED") {
    event.waitUntil(writeRecentMapDataCachePreference(event.data.enabled === true));
  }
});

// On activation: turn navigation preload OFF and clean up older app-shell
// caches. Serwist only ever *enables* preload, so a registration that an
// earlier SW switched on would otherwise stay on for this origin even after we
// set `navigationPreload: false` above — actively disable it so Firefox stops
// breaking offline cold launches. See the config note + workbox#3134.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable();
      }
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("app-shell-") && k !== APP_SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
    })(),
  );
});

serwist.addEventListeners();
