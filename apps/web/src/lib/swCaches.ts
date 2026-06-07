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

/**
 * Offline-area caches are checked only as a *fallback*, not first. Use for
 * region-independent, deploy-versioned assets (the map style JSON + sprite,
 * which live at one URL for every region): when online, the runtime strategy
 * fetches the fresh copy, so a style deploy takes effect even for users who
 * downloaded an offline area; when offline (the strategy yields nothing or
 * throws), the user's pinned copy still renders.
 *
 * Contrast with the tile/glyph routes, which check offline-area caches *first*
 * — those are region-specific and large, so a downloaded area should serve them
 * directly rather than re-fetch.
 */
export async function offlineFallback<T>(
  runStrategy: () => Promise<T>,
  matchOffline: () => Promise<T | null>,
): Promise<T> {
  try {
    const res = await runStrategy();
    if (res) return res;
    const offline = await matchOffline();
    return offline ?? res;
  } catch (err) {
    const offline = await matchOffline();
    if (offline) return offline;
    throw err;
  }
}
