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
  type RuntimeCaching,
  Serwist,
  StaleWhileRevalidate,
  type Strategy,
} from "serwist";
import { createNavigationRuntimeRoute } from "./lib/serviceWorkerNavigation";
import {
  isMapLibreRuntimeAssetPath,
  isNetworkOnlyApiPath,
  isOfflinePackageArchivePath,
  isOnlineStyleReachabilityProbe,
  isStalePrecacheName,
  MAPLIBRE_RUNTIME_CACHE,
  navigationFirstRuntimeCaching,
  offlineGlyphCacheNameForVersion,
  offlineGlyphVersionFromPath,
  STATIC_OFFLINE_FALLBACK_URL,
} from "./lib/swCaches";

declare const self: ServiceWorkerGlobalScope;

// Replaced at build time by scripts/build-sw.mjs (esbuild `define`) with a
// per-build id. Weaving it into the app-shell cache name below makes sw.js's
// bytes change every deploy, so the browser detects a new worker and
// SwUpdateNotice can surface the "update available" prompt — without it the
// custom esbuild output is identical across builds and updates never fire.
declare const __SW_BUILD_ID__: string;
declare const __MAPLIBRE_VERSION__: string;

const OFFLINE_URL = STATIC_OFFLINE_FALLBACK_URL;
const APP_SHELL_CACHE = `app-shell-${__SW_BUILD_ID__}`;
// Map-style assets (style JSON / sprite / TileJSON) are versioned by build id
// too, so a deploy that changes the self-hosted style serves the new one on the
// next load instead of the worker's stale copy. Old style caches are pruned on
// activate.
const STYLE_CACHE = `style-assets-${__SW_BUILD_ID__}`;
// Only a distinct, credential-free offline document is retained. The requested
// navigation (including `/`) is never stored or looked up in Cache Storage.
const BUNDLED_MAP_ASSETS = [
  "/styles/openmapx-streets.json",
  "/styles/openmapx-dark.json",
  "/styles/sprite.json",
  "/styles/sprite.png",
] as const;
const MAPLIBRE_RUNTIME_ASSETS = [
  `/runtime/maplibre-gl/${__MAPLIBRE_VERSION__}/maplibre-gl-worker.mjs`,
  `/runtime/maplibre-gl/${__MAPLIBRE_VERSION__}/maplibre-gl-shared.mjs`,
] as const;
const OPTIONAL_BUNDLED_MAP_ASSETS = ["/styles/sprite@2x.json", "/styles/sprite@2x.png"] as const;
const APP_SHELL_URLS = [OFFLINE_URL, "/manifest.webmanifest", ...BUNDLED_MAP_ASSETS];
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

/** Package font assets are small, explicit Cache Storage entries. */
async function matchOfflineGlyph(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const version =
    url.searchParams.get("offlineGlyphs") ?? offlineGlyphVersionFromPath(url.pathname);
  if (!version || !/^[A-Za-z0-9_-]{1,256}$/.test(version)) return null;
  const cache = await caches.open(offlineGlyphCacheNameForVersion(version));
  if (!url.searchParams.has("offlineGlyphs")) {
    url.searchParams.set("offlineGlyphs", version);
  }
  const exact = await cache.match(new Request(url.toString(), request), { ignoreSearch: false });
  if (exact) return exact;

  // Glyphs are pinned under a same-origin manifest path so changing
  // NEXT_PUBLIC_API_URL does not strand an otherwise valid offline package.
  url.protocol = self.location.protocol;
  url.host = self.location.host;
  return (await cache.match(url.toString(), { ignoreSearch: false })) ?? null;
}

function withRecentMapDataCache(strategy: Strategy): RouteHandlerCallback {
  return async (options: RouteHandlerCallbackOptions) => {
    if (!(await readRecentMapDataCachePreference())) {
      return fetch(options.request);
    }

    return strategy.handle(options);
  };
}

const bundledStyleFallbackStrategy = new StaleWhileRevalidate({
  cacheName: STYLE_CACHE,
  plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 })],
});

// Keep multiple versioned pairs because an already-open client or an offline
// page/runtime-cache entry can outlive the build-scoped app-shell cache. Each
// version is two files (~500 KiB total); 32 entries retain up to 16 MapLibre
// releases while keeping storage bounded. `last-used` also registers pairs
// written by a prior worker the first time they are read.
const maplibreRuntimeStrategy = new CacheFirst({
  cacheName: MAPLIBRE_RUNTIME_CACHE,
  plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeFrom: "last-used" })],
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
  runtimeCaching: navigationFirstRuntimeCaching<RuntimeCaching>(
    // This must remain first: a navigation URL can syntactically resemble a
    // style, PBF, or public API asset, but document authority always wins.
    createNavigationRuntimeRoute({ appShellCacheName: APP_SHELL_CACHE }),
    [
      // PMTiles archives are streamed into OPFS/IndexedDB by the page. A full
      // archive in Cache Storage would silently double offline-map disk use.
      // Marked TileJSON probes must also bypass cached responses or they cannot
      // distinguish current backend reachability from a stale runtime entry.
      // Keep this after the navigation boundary and before every cache-backed
      // subresource route and Serwist's default rules.
      {
        matcher: ({ url }: { url: URL }) =>
          isOfflinePackageArchivePath(url.pathname) || isOnlineStyleReachabilityProbe(url),
        handler: ({ request }: { request: Request }) => fetch(request),
      },

      // API responses are network-only by default. Only the small public-data
      // allowlist in swCaches may fall through to a cache-backed route below.
      // This direction is intentional: a new session/admin/service route cannot
      // become cacheable merely because someone forgot to update this worker.
      // Serwist ignores `Cache-Control: no-store` (its default cacheWillUpdate
      // accepts any 200), so classification must happen before `defaultCache`'s
      // broad same- and cross-origin `/api/` NetworkFirst rules. Non-GET requests
      // are never cache candidates even when their pathname shares a public GET.
      {
        matcher: ({ request, url }: { request: Request; url: URL }) =>
          url.pathname.startsWith("/api/") &&
          (request.method !== "GET" || isNetworkOnlyApiPath(url.pathname)),
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

      // MapLibre's ESM worker and its shared module are copied from the installed
      // package under a versioned path. Match every valid version so an older
      // client can keep using its retained pair after a new worker activates.
      {
        matcher: ({ url }: { url: URL }) =>
          url.origin === self.location.origin && isMapLibreRuntimeAssetPath(url.pathname),
        handler: maplibreRuntimeStrategy,
      },

      // Package font assets are small and explicitly versioned by the package.
      // The archive itself is read by the page-side PMTiles protocol and never
      // enters Cache Storage.
      {
        matcher: ({ url }: { url: URL }) =>
          url.searchParams.has("offlineGlyphs") ||
          offlineGlyphVersionFromPath(url.pathname) !== undefined,
        handler: async ({ request }: { request: Request }) =>
          (await matchOfflineGlyph(request)) ?? fetch(request),
      },

      // MapTiler tiles / style / sprite / glyphs via API proxy — runtime SWR.
      {
        matcher: /\/api\/maptiler\//i,
        handler: new StaleWhileRevalidate({
          cacheName: "map-tiles",
          plugins: [new ExpirationPlugin({ maxEntries: 1000, maxAgeSeconds: 7 * 24 * 60 * 60 })],
        }),
      },

      // Mapillary coverage tiles via API proxy — StaleWhileRevalidate
      {
        matcher: /\/api\/integrations\/street-level-imagery-[a-z0-9-]+\/tiles\//i,
        handler: new StaleWhileRevalidate({
          cacheName: "street-level-imagery-tiles",
          plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 3 * 24 * 60 * 60 })],
        }),
      },

      // Self-hosted map style assets — runtime SWR. Package font requests carry
      // an `offlineGlyphs` query and are handled by the explicit route above.
      {
        matcher: ({ url }: { url: URL }) => /\/styles\//i.test(url.pathname),
        handler: async (options) => {
          const bundled = await (await caches.open(APP_SHELL_CACHE)).match(options.request, {
            ignoreSearch: true,
          });
          if (bundled) return bundled;
          return bundledStyleFallbackStrategy.handle(options);
        },
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

      // Self-hosted vector tiles & font glyphs (.pbf) — online runtime cache.
      {
        matcher: /\.pbf(\?.*)?$/i,
        handler: new CacheFirst({
          cacheName: "vector-tiles",
          plugins: [new ExpirationPlugin({ maxEntries: 5000, maxAgeSeconds: 30 * 24 * 60 * 60 })],
        }),
      },

      ...defaultCache,
    ],
  ),
});

// Precache the offline page + manifest at install time so a cold-start while
// offline still renders something useful. We don't use Serwist's precacheEntries
// because the custom esbuild build pipeline doesn't inject the build manifest.
//
// Required shell/style assets fail installation as a unit. Optional high-DPI
// sprites are fetched independently because not every build supplies them.
self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        await Promise.all(
          APP_SHELL_URLS.map(async (url) => {
            const response = await fetch(url, { cache: "reload", credentials: "omit" });
            if (!response.ok) throw new Error(`required app-shell asset unavailable: ${url}`);
            await cache.put(url, response);
          }),
        );
        await Promise.allSettled(
          OPTIONAL_BUNDLED_MAP_ASSETS.map(async (url) => {
            const response = await fetch(url, { cache: "reload", credentials: "omit" });
            if (response.ok) await cache.put(url, response);
          }),
        );
      }),
      Promise.all(
        MAPLIBRE_RUNTIME_ASSETS.map(async (url) => {
          const [responsePromise, donePromise] = maplibreRuntimeStrategy.handleAll({
            event,
            request: new Request(url, { cache: "reload" }),
          });
          const response = await responsePromise;
          await donePromise;
          if (!response?.ok) throw new Error(`required MapLibre runtime asset unavailable: ${url}`);
        }),
      ),
    ]),
  );
});

// Allow the page to trigger skipWaiting — gates SW updates behind a user
// confirmation in the UI.
self.addEventListener("message", (event) => {
  // Service-worker message events are same-origin-scoped by the platform, but
  // verify explicitly: ignore anything whose origin isn't this SW's origin.
  if (event.origin && event.origin !== self.location.origin) return;

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

serwist.addEventListeners();
