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

export function offlineStyleCacheNameForVersion(version: string): string {
  return `offline-package-style-${version.replace(/[^A-Za-z0-9_-]/g, "_")}`;
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
