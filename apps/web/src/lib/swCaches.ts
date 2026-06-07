/**
 * Decides whether a Cache Storage entry is a stale, build-versioned precache the
 * service worker should drop on activate. We version two caches by build id —
 * the app shell (`app-shell-<id>`) and the map-style assets (`style-assets-<id>`,
 * plus the legacy unversioned `style-assets`) — so a new deploy serves fresh app
 * code and a fresh map style instead of whatever the previous worker cached.
 *
 * Everything else is left alone — notably `offline-area-*` (user-pinned offline
 * maps, intentionally kept across style deploys) and the other runtime caches
 * (`pages`, `mapillary-tiles`, `api-*`), which manage their own expiry.
 */
export function isStalePrecacheName(
  name: string,
  current: { appShell: string; style: string },
): boolean {
  if (name.startsWith("app-shell-")) return name !== current.appShell;
  if (name.startsWith("style-assets")) return name !== current.style;
  return false;
}
