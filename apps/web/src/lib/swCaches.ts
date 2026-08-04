export const MAPLIBRE_RUNTIME_CACHE = "maplibre-runtimes";

/** Return whether a build-versioned service-worker cache belongs to an older build. */
export function isStalePrecacheName(
  name: string,
  current: { appShell: string; style: string },
): boolean {
  if (name.startsWith("app-shell-")) return name !== current.appShell;
  if (name.startsWith("style-assets")) return name !== current.style;
  // The package archive implementation deliberately does not read the old
  // per-tile caches. Remove them on the next worker activation so they do not
  // continue consuming device storage.
  if (name.startsWith("offline-area-") || name === "omx-offline-results") return true;
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

export function isCredentialedApiPath(pathname: string): boolean {
  const entries = [
    "/api/auth/",
    "/api/admin/",
    "/api/saved/",
    "/api/me",
    "/api/reviews/keypair",
  ] as const;
  return entries.some((entry) =>
    entry.endsWith("/")
      ? pathname.startsWith(entry)
      : pathname === entry || pathname.startsWith(`${entry}/`),
  );
}
