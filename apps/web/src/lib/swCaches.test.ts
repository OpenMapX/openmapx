import { afterEach, describe, expect, it, vi } from "vitest";
import openApiDocument from "../../../api/openapi.json";
import { createNavigationRuntimeRoute } from "./serviceWorkerNavigation";
import {
  appShellCacheNames,
  handleNetworkOnlyNavigation,
  isMapLibreRuntimeAssetPath,
  isNetworkOnlyApiPath,
  isOfflinePackageArchivePath,
  isOnlineStyleReachabilityProbe,
  isPublicCacheableApiPath,
  isStalePrecacheName,
  MAPLIBRE_RUNTIME_CACHE,
  navigationCachePolicy,
  navigationFirstRuntimeCaching,
  offlineGlyphCacheNameForVersion,
  offlineGlyphVersionFromPath,
  PUBLIC_CACHEABLE_API_PATH_TEMPLATES,
} from "./swCaches";

afterEach(() => {
  vi.unstubAllGlobals();
});

const packageId = `omp2-${"a".repeat(64)}`;

const current = { appShell: "app-shell-NEW", style: "style-assets-NEW" };

describe("service-worker cache names", () => {
  it("lists only existing app-shell caches", async () => {
    vi.stubGlobal("caches", {
      keys: async () => ["app-shell-abc", "style-assets-abc", "map-tiles"],
    });

    expect(await appShellCacheNames()).toEqual(["app-shell-abc"]);
  });

  it("returns no app-shell caches when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);

    expect(await appShellCacheNames()).toEqual([]);
  });

  it("keeps current build caches and removes older build caches", () => {
    expect(isStalePrecacheName("app-shell-NEW", current)).toBe(false);
    expect(isStalePrecacheName("style-assets-NEW", current)).toBe(false);
    expect(isStalePrecacheName("app-shell-OLD", current)).toBe(true);
    expect(isStalePrecacheName("style-assets-OLD", current)).toBe(true);
    expect(isStalePrecacheName("style-assets", current)).toBe(true);
  });

  it("leaves caches outside the build-versioned precache families alone", () => {
    expect(isStalePrecacheName("offline-package-glyphs-abc", current)).toBe(false);
    expect(isStalePrecacheName(MAPLIBRE_RUNTIME_CACHE, current)).toBe(false);
    expect(isStalePrecacheName("map-tiles", current)).toBe(false);
  });

  it("uses a stable, cache-safe package style name", () => {
    expect(offlineGlyphCacheNameForVersion("glyphs/v1?x")).toBe(
      "offline-package-glyphs-glyphs_v1_x",
    );
  });

  it("extracts the version from an unquery-pinned package asset path", () => {
    expect(
      offlineGlyphVersionFromPath("/api/offline/packages/glyphs/glyphs-v1/Metropolis/0-255.pbf"),
    ).toBe("glyphs-v1");
    expect(
      offlineGlyphVersionFromPath("/api/offline/packages/assets/maptiler/style-v1"),
    ).toBeUndefined();
  });
});

describe("navigation cache policy", () => {
  it.each([
    "https://maps.example/",
    "https://maps.example/admin/users",
    "https://maps.example/settings",
    "https://maps.example/mobile-auth?state=secret-state&code=secret-code",
    "https://maps.example/?token=secret-token",
    "https://maps.example/auth/callback?state=secret-state&error=denied",
  ])("makes the navigation network-only with an exact static fallback: %s", (url) => {
    expect(navigationCachePolicy({ mode: "navigate", url })).toEqual({
      strategy: "network-only",
      fallback: { url: "/offline", ignoreSearch: false },
    });
  });

  it("does not classify non-navigation requests as documents", () => {
    expect(
      navigationCachePolicy({ mode: "same-origin", url: "https://maps.example/admin/users" }),
    ).toBeNull();
  });

  it("selects NetworkOnly before cacheable style, PBF, and public API routes", () => {
    type FixtureRequest = { mode: RequestMode; url: string };
    type FixtureRoute = { id: string; matches(request: FixtureRequest): boolean };
    const navigation: FixtureRoute = {
      id: "navigation-network-only",
      matches: (request) => navigationCachePolicy(request) !== null,
    };
    const routes = navigationFirstRuntimeCaching(navigation, [
      {
        id: "style-cache",
        matches: (request) => new URL(request.url).pathname.startsWith("/styles/"),
      },
      {
        id: "pbf-cache",
        matches: (request) => new URL(request.url).pathname.endsWith(".pbf"),
      },
      {
        id: "public-api-cache",
        matches: (request) => isPublicCacheableApiPath(new URL(request.url).pathname),
      },
    ]);

    for (const url of [
      "https://maps.example/styles/openmapx-streets.json?token=secret",
      "https://maps.example/runtime/font.pbf?code=secret",
      "https://maps.example/api/places/123?state=secret",
    ]) {
      const selected = routes.find((route) => route.matches({ mode: "navigate", url }));
      expect({ url, selected: selected?.id }).toEqual({
        url,
        selected: "navigation-network-only",
      });
    }
  });

  it("never writes identity HTML or a token-bearing request into Cache Storage", async () => {
    class TestExtendableEvent {
      readonly lifetimePromises: Promise<unknown>[] = [];

      waitUntil(promise: Promise<unknown>) {
        this.lifetimePromises.push(promise);
      }
    }
    class TestFetchEvent extends TestExtendableEvent {}
    vi.stubGlobal("ExtendableEvent", TestExtendableEvent);
    vi.stubGlobal("FetchEvent", TestFetchEvent);

    const requestUrl = (request: RequestInfo | URL) =>
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    const runtimeCaches = new Map<string, Map<string, string>>();
    async function openRuntimeCache(cacheName: string): Promise<Cache> {
      let entries = runtimeCaches.get(cacheName);
      if (!entries) {
        entries = new Map();
        runtimeCaches.set(cacheName, entries);
      }
      return {
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        match: async (request: RequestInfo | URL) => {
          const body = entries.get(requestUrl(request));
          return body === undefined ? undefined : new Response(body);
        },
        put: async (request: RequestInfo | URL, response: Response) => {
          entries.set(requestUrl(request), await response.clone().text());
        },
      } as unknown as Cache;
    }
    const openCache = vi.fn();
    openCache.mockImplementation((...args: unknown[]) => openRuntimeCache(String(args[0])));
    const cacheStorage = {
      keys: async () => [...runtimeCaches.keys()],
      open: (cacheName: string) => openCache(cacheName) as Promise<Cache>,
    };
    vi.stubGlobal("caches", cacheStorage);

    const identityHtml =
      '<main data-name="Ada" data-email="ada@example.test" data-role="admin">private</main>';
    const tokenUrl = "https://maps.example/?token=must-not-enter-cache";
    const request = new Request(tokenUrl);
    Object.defineProperty(request, "mode", { value: "navigate" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(identityHtml)),
    );
    const event = new TestExtendableEvent();
    const route = createNavigationRuntimeRoute({
      appShellCacheName: "app-shell-test",
      cacheStorage,
    });

    expect(route.matcher({ request })).toBe(true);
    const response = await route.handler({ event, request, url: new URL(request.url) });
    await Promise.all(event.lifetimePromises);

    expect(await response.text()).toBe(identityHtml);
    expect(openCache).not.toHaveBeenCalled();
    const runtimeEntries: Array<{ body: string; cacheName: string; url: string }> = [];
    for (const cacheName of await cacheStorage.keys()) {
      const cache = await cacheStorage.open(cacheName);
      for (const cachedRequest of await cache.keys()) {
        const cachedResponse = await cache.match(cachedRequest);
        runtimeEntries.push({
          body: (await cachedResponse?.text()) ?? "",
          cacheName,
          url: cachedRequest.url,
        });
      }
    }
    expect(runtimeEntries).toEqual([]);
    const serializedEntries = JSON.stringify(runtimeEntries);
    for (const secret of [tokenUrl, "must-not-enter-cache", "Ada", "ada@example.test", "admin"]) {
      expect(serializedEntries).not.toContain(secret);
    }
  });

  it("matches only the distinct offline key when the network fails", async () => {
    const matches: Array<{ url: string; ignoreSearch: boolean }> = [];
    const offline = new Response("static offline page");

    const response = await handleNetworkOnlyNavigation({
      request: new Request("https://maps.example/auth/callback?code=secret&state=secret"),
      networkOnly: async () => {
        throw new TypeError("offline");
      },
      matchOffline: async (url, options) => {
        matches.push({ url, ignoreSearch: options.ignoreSearch });
        return offline;
      },
    });

    expect(response).toBe(offline);
    expect(matches).toEqual([{ url: "/offline", ignoreSearch: false }]);
  });
});

describe("MapLibre runtime cache", () => {
  it("recognizes versioned worker modules", () => {
    for (const path of [
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
      "/runtime/maplibre-gl/5.24.0/maplibre-gl-shared.mjs",
    ])
      expect(isMapLibreRuntimeAssetPath(path)).toBe(true);
  });

  it("rejects unversioned, malformed, and unrelated runtime paths", () => {
    for (const path of [
      "/runtime/maplibre-gl/maplibre-gl-worker.mjs",
      "/runtime/maplibre-gl/6.1.0/maplibre-gl.mjs",
      "/runtime/maplibre-gl/6.1.0/nested/maplibre-gl-worker.mjs",
      "/runtime/react.js",
    ])
      expect(isMapLibreRuntimeAssetPath(path)).toBe(false);
  });
});

describe("service-worker API authority", () => {
  it("makes every private or operational API path network-only", () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/sign-out",
      "/api/me",
      "/api/reviews/keypair",
      "/api/reviews/keypair/wraps",
      "/api/admin/audit",
      "/api/saved/lists",
      "/api/timeline/connection",
      "/api/timeline/connection/test",
      "/api/timeline/day/2026-08-09",
      "/api/osm/contributions/changesets",
      "/api/transit/registry",
      "/api/data-manager/status",
    ])
      expect(isNetworkOnlyApiPath(path)).toBe(true);
  });

  it("opts only reviewed public-data routes into API caching", () => {
    for (const path of [
      "/api/places/123",
      "/api/integrations/geocoding/geocode",
      "/api/maptiler/tiles.json",
      "/api/tiles/terrain/14/8/5.png",
      "/api/traffic/flow/14/8/5.png",
      "/api/offline/packages/glyphs/glyphs-v1/font/0-255.pbf",
    ])
      expect(isPublicCacheableApiPath(path)).toBe(true);

    for (const path of [
      "/api/places/search",
      "/api/unknown/new-route",
      "/styles/openmapx-streets.json",
      "/tiles/14/8/5.pbf",
      "/",
    ])
      expect(isPublicCacheableApiPath(path)).toBe(false);
  });

  it("keeps every non-allowlisted API path network-only", () => {
    expect(isNetworkOnlyApiPath("/api/unknown/new-route")).toBe(true);
    expect(isNetworkOnlyApiPath("/api/admin/audit")).toBe(true);
    expect(isNetworkOnlyApiPath("/styles/openmapx-streets.json")).toBe(false);
  });

  it("allows caching only for OpenAPI routes classified as public", () => {
    const paths = openApiDocument.paths as Record<
      string,
      Record<string, { "x-openmapx-auth"?: string }>
    >;

    for (const template of PUBLIC_CACHEABLE_API_PATH_TEMPLATES) {
      const operations = paths[template];
      expect({ template, present: operations !== undefined }).toEqual({ template, present: true });
      for (const [method, operation] of Object.entries(operations ?? {})) {
        expect({
          template,
          method: method.toUpperCase(),
          auth: operation["x-openmapx-auth"],
        }).toEqual({ template, method: method.toUpperCase(), auth: "public" });
      }
    }

    for (const [template, operations] of Object.entries(paths)) {
      const hasNonPublicOperation = Object.values(operations).some(
        (operation) => operation["x-openmapx-auth"] !== "public",
      );
      if (hasNonPublicOperation) expect(isPublicCacheableApiPath(template)).toBe(false);
    }
  });
});

describe("network-only offline map requests", () => {
  it("matches only canonical offline package archive paths", () => {
    expect(isOfflinePackageArchivePath(`/api/offline/packages/${packageId}/archive`)).toBe(true);

    for (const path of [
      `/api/offline/packages/${packageId}`,
      `/api/offline/packages/${packageId}/archive/extra`,
      "/api/offline/packages/not-a-package/archive",
      `/offline/packages/${packageId}/archive`,
      "/api/offline/packages/glyphs/glyphs-v1/font/0-255.pbf",
    ])
      expect(isOfflinePackageArchivePath(path)).toBe(false);
  });

  it("recognizes only explicit online-style reachability probes", () => {
    expect(
      isOnlineStyleReachabilityProbe(
        new URL("https://maps.example/api/maptiler/tiles.json?openmapxReachability=1"),
      ),
    ).toBe(true);

    for (const url of [
      "https://maps.example/api/maptiler/tiles.json",
      "https://maps.example/api/maptiler/tiles.json?openmapxReachability=0",
      "https://maps.example/api/maptiler/tiles.json?openmapxReachability=true",
    ])
      expect(isOnlineStyleReachabilityProbe(new URL(url))).toBe(false);
  });
});
