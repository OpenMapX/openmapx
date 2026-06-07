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
import { isStalePrecacheName, offlineFallback } from "./lib/swCaches";

declare const self: ServiceWorkerGlobalScope;

// Background Fetch API (not in lib.webworker) — only what we consume, plus the
// event-map augmentation so `addEventListener` types the handler events.
interface BackgroundFetchRecord {
  readonly request: Request;
  readonly responseReady: Promise<Response>;
}
interface BackgroundFetchRegistrationSW extends EventTarget {
  readonly id: string;
  readonly downloaded: number;
  readonly downloadTotal: number;
  readonly failureReason: string;
  matchAll(): Promise<BackgroundFetchRecord[]>;
}
interface BackgroundFetchEvent extends ExtendableEvent {
  readonly registration: BackgroundFetchRegistrationSW;
}
declare global {
  interface ServiceWorkerGlobalScopeEventMap {
    backgroundfetchsuccess: BackgroundFetchEvent;
    backgroundfetchfail: BackgroundFetchEvent;
    backgroundfetchabort: BackgroundFetchEvent;
    backgroundfetchclick: BackgroundFetchEvent;
  }
}

// Replaced at build time by scripts/build-sw.mjs (esbuild `define`) with a
// per-build id. Weaving it into the app-shell cache name below makes sw.js's
// bytes change every deploy, so the browser detects a new worker and
// SwUpdateNotice can surface the "update available" prompt — without it the
// custom esbuild output is identical across builds and updates never fire.
declare const __SW_BUILD_ID__: string;

const OFFLINE_URL = "/offline";
const HOME_URL = "/";
const APP_SHELL_CACHE = `app-shell-${__SW_BUILD_ID__}`;
// Map-style assets (style JSON / sprite / TileJSON) are versioned by build id
// too, so a deploy that changes the self-hosted style serves the new one on the
// next load instead of the worker's stale copy. Old style caches are pruned on
// activate; downloaded offline areas (offline-area-*) are intentionally kept.
const STYLE_CACHE = `style-assets-${__SW_BUILD_ID__}`;
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

/**
 * Like withOfflineFirst, but the runtime strategy wins when it can respond and
 * the offline-area pin is only a fallback. Used for the map style / sprite,
 * which share one region-independent URL — so a downloaded area must not freeze
 * the style globally after a deploy, yet still renders offline.
 */
function withOfflineFallback(strategy: Strategy): RouteHandlerCallback {
  return (options: RouteHandlerCallbackOptions) =>
    offlineFallback(
      () => strategy.handle(options),
      () => matchOfflineArea(options.request),
    );
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
    // TileJSON live here. These share one region-independent URL, so we use
    // offline-FALLBACK (not offline-first): online, the build-versioned runtime
    // cache serves the fresh style after a deploy even when the user has a
    // downloaded area pinning the old one; offline, the area's copy still
    // renders. (Tiles/glyphs below stay offline-first — they're per-region.)
    {
      matcher: ({ url }: { url: URL }) => /\/styles\//i.test(url.pathname),
      handler: withOfflineFallback(
        new StaleWhileRevalidate({
          cacheName: STYLE_CACHE,
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
          .filter((k) => isStalePrecacheName(k, { appShell: APP_SHELL_CACHE, style: STYLE_CACHE }))
          .map((k) => caches.delete(k)),
      );
    })(),
  );
});

// Background Fetch — reliable offline-area downloads that survive navigation and
// the page closing, with an OS progress notification. The client kicks one off
// (see lib/offlineAreas/backgroundDownload); here we land the results into the
// same `offline-area-<id>` cache the in-page downloader uses, write a small
// completion marker the page reconciles from, and ping any open client.
const OFFLINE_AREA_RESULTS_CACHE = "omx-offline-results";

async function writeAreaResult(
  id: string,
  data: { ok: boolean; downloaded?: number; count?: number; reason?: string },
): Promise<void> {
  const cache = await caches.open(OFFLINE_AREA_RESULTS_CACHE);
  await cache.put(
    `/__offline-area-result/${encodeURIComponent(id)}`,
    new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }),
  );
}

async function notifyOfflineAreaDone(id: string, ok: boolean): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type: "OFFLINE_AREA_DONE", id, ok });
}

/** Show an app-icon badge so a finished background download is noticeable when
 * the app is closed/backgrounded. Cleared when the user opens Offline maps. */
async function badgeOfflineDownloadDone(): Promise<void> {
  const nav = navigator as unknown as { setAppBadge?: (n?: number) => Promise<void> };
  if (typeof nav.setAppBadge !== "function") return;
  try {
    await nav.setAppBadge(1);
  } catch {
    // badging is optional
  }
}

/** Copy a Background Fetch's successful responses into the area cache. */
async function storeBackgroundFetchRecords(reg: BackgroundFetchRegistrationSW): Promise<number> {
  const cache = await caches.open(`${OFFLINE_AREA_CACHE_PREFIX}${reg.id}`);
  const records = await reg.matchAll();
  let stored = 0;
  await Promise.all(
    records.map(async (record) => {
      const response = await record.responseReady.catch(() => null);
      // Skip 4xx/5xx (e.g. ocean tiles past coverage) — matches the in-page path.
      if (response?.ok) {
        await cache.put(record.request, response);
        stored += 1;
      }
    }),
  );
  return stored;
}

self.addEventListener("backgroundfetchsuccess", (event) => {
  const reg = event.registration;
  event.waitUntil(
    (async () => {
      try {
        const count = await storeBackgroundFetchRecords(reg);
        await writeAreaResult(reg.id, { ok: true, downloaded: reg.downloaded, count });
        await notifyOfflineAreaDone(reg.id, true);
        await badgeOfflineDownloadDone();
      } catch (err) {
        await writeAreaResult(reg.id, {
          ok: false,
          reason: (err as Error)?.message ?? "store failed",
        });
        await notifyOfflineAreaDone(reg.id, false);
      }
    })(),
  );
});

self.addEventListener("backgroundfetchfail", (event) => {
  const reg = event.registration;
  event.waitUntil(
    (async () => {
      // Keep whatever did download so a partial area is still usable.
      let count = 0;
      try {
        count = await storeBackgroundFetchRecords(reg);
      } catch {
        // best-effort
      }
      await writeAreaResult(reg.id, {
        ok: false,
        downloaded: reg.downloaded,
        count,
        reason: reg.failureReason || "fetch failed",
      });
      await notifyOfflineAreaDone(reg.id, false);
    })(),
  );
});

self.addEventListener("backgroundfetchabort", (event) => {
  event.waitUntil(writeAreaResult(event.registration.id, { ok: false, reason: "aborted" }));
});

self.addEventListener("backgroundfetchclick", (event) => {
  const target = new URL("/settings/offline", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => c.url.includes("/settings/offline"));
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

serwist.addEventListeners();
