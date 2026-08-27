export const MAPLIBRE_RUNTIME_CACHE = "maplibre-runtimes";

export const STATIC_OFFLINE_FALLBACK_URL = "/offline";

/** Navigation responses are never cache candidates, regardless of their URL. */
export function navigationCachePolicy(request: Pick<Request, "mode" | "url">) {
  if (request.mode !== "navigate") return null;
  return {
    strategy: "network-only",
    fallback: { url: STATIC_OFFLINE_FALLBACK_URL, ignoreSearch: false },
  } as const;
}

/** Construct runtime routing so document authority cannot be shadowed by an asset route. */
export function navigationFirstRuntimeCaching<T>(navigation: T, others: readonly T[]): T[] {
  return [navigation, ...others];
}

/**
 * Resolve a navigation from the network or the separately cached static
 * offline page. The requested URL is deliberately never passed to Cache
 * Storage, preventing both document replay and query-insensitive token lookup.
 */
export async function handleNetworkOnlyNavigation({
  request,
  networkOnly,
  matchOffline,
}: {
  request: Request;
  networkOnly(request: Request): Promise<Response>;
  matchOffline(
    url: typeof STATIC_OFFLINE_FALLBACK_URL,
    options: { ignoreSearch: false },
  ): Promise<Response | undefined>;
}): Promise<Response> {
  try {
    return await networkOnly(request);
  } catch (error) {
    const fallback = await matchOffline(STATIC_OFFLINE_FALLBACK_URL, { ignoreSearch: false });
    if (fallback) return fallback;
    throw error;
  }
}

/**
 * Names of the app-shell precaches that currently exist. Client code cannot
 * name the build-versioned cache directly because the build id is defined only
 * in the worker bundle, so callers that need to refresh shell entries enumerate
 * them.
 */
export async function appShellCacheNames(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  return (await caches.keys()).filter((name) => name.startsWith("app-shell-"));
}

/** Return whether a build-versioned service-worker cache belongs to an older build. */
export function isStalePrecacheName(
  name: string,
  current: { appShell: string; style: string },
): boolean {
  if (name.startsWith("app-shell-")) return name !== current.appShell;
  if (name.startsWith("style-assets")) return name !== current.style;
  return false;
}

export function isMapLibreRuntimeAssetPath(pathname: string): boolean {
  return /^\/runtime\/maplibre-gl\/[A-Za-z0-9._+-]{1,128}\/maplibre-gl-(?:worker|shared)\.mjs$/.test(
    pathname,
  );
}

export function offlineGlyphCacheNameForVersion(version: string): string {
  return `offline-package-glyphs-${version.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function offlineGlyphVersionFromPath(pathname: string): string | undefined {
  const match = /^\/api\/offline\/packages\/glyphs\/([A-Za-z0-9_-]{1,256})(?:\/|$)/.exec(pathname);
  return match?.[1];
}

/** Package archives live in OPFS/IndexedDB and must never be duplicated in Cache Storage. */
export function isOfflinePackageArchivePath(pathname: string): boolean {
  return /^\/api\/offline\/packages\/omp2-[0-9a-f]{64}\/archive$/.test(pathname);
}

/** A marked probe must bypass runtime caches so it measures current online reachability. */
export function isOnlineStyleReachabilityProbe(url: URL): boolean {
  return url.searchParams.get("openmapxReachability") === "1";
}

/**
 * GET routes whose response is intentionally safe to share across users.
 *
 * The companion test resolves every entry against the committed OpenAPI
 * document and requires `x-openmapx-auth: public`. Adding a cached API route is
 * therefore an explicit security review, while adding any ordinary API route
 * is network-only without touching the service worker.
 */
export const PUBLIC_CACHEABLE_API_PATH_TEMPLATES = [
  "/api/maptiler/{wildcard}",
  "/api/offline/packages/glyphs/{version}/catalog.json",
  "/api/offline/packages/glyphs/{version}/{wildcard}",
  "/api/tiles/cycling-routes/{z}/{x}/{y}.png",
  "/api/tiles/cyclosm/{z}/{x}/{y}.png",
  "/api/tiles/terrain/{z}/{x}/{y}.png",
  "/api/traffic/flow/{z}/{x}/{y}.png",
  "/api/integrations/street-level-imagery-mapillary/tiles/{z}/{x}/{y}",
  "/api/integrations/street-level-imagery-panoramax/tiles/{z}/{x}/{y}",
  "/api/integrations/geocoding/autocomplete",
  "/api/integrations/geocoding/geocode",
  "/api/integrations/geocoding/geocode/country",
  "/api/integrations/geocoding/geocode/reverse",
  "/api/integrations/routing/directions",
  "/api/integrations/routing/directions/optimize",
  "/api/integrations/weather/current",
  "/api/integrations/weather/forecast",
  "/api/integrations/photos/search",
  "/api/places/{id}",
] as const;

export function isPublicCacheableApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/maptiler/") ||
    /^\/api\/offline\/packages\/glyphs\/[^/]+\/(?:catalog\.json|.+)$/.test(pathname) ||
    /^\/api\/tiles\/(?:cycling-routes|cyclosm|terrain)\/[^/]+\/[^/]+\/[^/]+\.png$/.test(pathname) ||
    /^\/api\/traffic\/flow\/[^/]+\/[^/]+\/[^/]+\.png$/.test(pathname) ||
    /^\/api\/integrations\/street-level-imagery-(?:mapillary|panoramax)\/tiles\/[^/]+\/[^/]+\/[^/]+$/.test(
      pathname,
    ) ||
    /^\/api\/integrations\/geocoding\/(?:autocomplete|geocode(?:\/country|\/reverse)?)$/.test(
      pathname,
    ) ||
    /^\/api\/integrations\/routing\/directions(?:\/optimize)?$/.test(pathname) ||
    /^\/api\/integrations\/weather\/(?:current|forecast)$/.test(pathname) ||
    pathname === "/api/integrations/photos/search" ||
    (pathname !== "/api/places/search" && /^\/api\/places\/[^/]+$/.test(pathname))
  );
}

/** Every API path is network-only unless it passed the public-data allowlist. */
export function isNetworkOnlyApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") && !isPublicCacheableApiPath(pathname);
}
