import { defaultCache } from "@serwist/next/worker";
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist, StaleWhileRevalidate } from "serwist";

const serwist = new Serwist({
  precacheEntries: [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Next.js static assets — CacheFirst (immutable, build-hash versioned)
    {
      matcher: /^\/_next\/static\/.*/i,
      handler: new CacheFirst({
        cacheName: "static-assets",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },

    // MapTiler tiles — StaleWhileRevalidate (cross-origin public CDN)
    {
      matcher: /^https:\/\/api\.maptiler\.com\/.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: "map-tiles",
        plugins: [new ExpirationPlugin({ maxEntries: 1000, maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },

    // Mapillary tiles — StaleWhileRevalidate
    {
      matcher: /^https:\/\/tiles\.mapillary\.com\/.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: "mapillary-tiles",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 3 * 24 * 60 * 60 })],
      }),
    },

    // API geodata — StaleWhileRevalidate
    // Covers: /api/geocode, /api/geocode/reverse, /api/places/:id, /api/directions
    // Excludes: /api/places/search (category search embeds live fuel prices)
    {
      matcher: ({ url }: { url: URL }) =>
        /\/api\/(geocode|places|directions)/.test(url.pathname) &&
        !url.pathname.includes("/places/search"),
      handler: new StaleWhileRevalidate({
        cacheName: "api-geodata",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 24 * 60 * 60 })],
      }),
    },

    // Category search — NetworkFirst (contains live fuel prices)
    {
      matcher: /\/api\/places\/search/,
      handler: new NetworkFirst({
        cacheName: "api-category-search",
        networkTimeoutSeconds: 5,
        plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 })],
      }),
    },

    // Autocomplete — NetworkFirst (fresh suggestions always preferred)
    {
      matcher: /\/api\/autocomplete/,
      handler: new NetworkFirst({
        cacheName: "api-autocomplete",
        networkTimeoutSeconds: 3,
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 })],
      }),
    },

    // App shell HTML — NetworkFirst with offline fallback
    {
      matcher: ({ request }: { request: Request }) => request.mode === "navigate",
      handler: new NetworkFirst({
        cacheName: "pages",
        networkTimeoutSeconds: 3,
        plugins: [new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 })],
      }),
    },

    ...defaultCache,
  ],
});

serwist.addEventListeners();
