/**
 * Decides whether a Cache Storage entry is a stale, build-versioned precache the
 * service worker should drop on activate. We version two caches by build id —
 * the app shell (`app-shell-<id>`) and the map-style assets (`style-assets-<id>`,
 * plus the legacy unversioned `style-assets`) — so a new deploy serves fresh app
 * code and a fresh map style instead of whatever the previous worker cached.
 *
 * Everything else is left alone — notably `offline-area-*` (user-pinned offline
 * maps, intentionally kept across style deploys) and the other runtime caches
 * (`pages`, `street-level-imagery-tiles`, `api-*`), which manage their own expiry.
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

export interface PinnedStyleCache {
  keys(): Promise<ReadonlyArray<{ readonly url: string }>>;
  match(url: string): Promise<{ headers: { get(name: string): string | null } } | undefined>;
  put(url: string, response: unknown): Promise<void>;
}

export interface RefreshPinnedStylesDeps {
  /** Cache names of downloaded offline areas. */
  listAreaCacheNames(): Promise<string[]>;
  openCache(name: string): Promise<PinnedStyleCache>;
  /** True for region-independent style/sprite URLs (e.g. under `/styles/`). */
  isStyleUrl(url: string): boolean;
  /**
   * Conditional GET: re-fetch `url` sending the pinned ETag as If-None-Match.
   * Resolve with the response (status 304 = unchanged, 200 = changed) or `null`
   * when offline / the request fails.
   */
  fetchFresh(url: string, etag: string | null): Promise<{ status: number } | null>;
}

/**
 * Refresh the style/sprite copies pinned inside downloaded offline-area caches,
 * but only the ones that actually changed. For each pinned style URL we issue a
 * conditional request with the stored ETag: a `304` leaves the pin untouched, a
 * `200` replaces it. This keeps offline rendering on the latest style after a
 * deploy without re-downloading anything when nothing changed (most activates).
 * Best-effort: offline / failed fetches are skipped so the existing pin stays.
 * Returns how many entries were replaced.
 */
export async function refreshPinnedStyleAssets(deps: RefreshPinnedStylesDeps): Promise<number> {
  let replaced = 0;
  for (const name of await deps.listAreaCacheNames()) {
    const cache = await deps.openCache(name);
    for (const { url } of await cache.keys()) {
      if (!deps.isStyleUrl(url)) continue;
      const pinned = await cache.match(url);
      const fresh = await deps.fetchFresh(url, pinned?.headers.get("etag") ?? null);
      if (fresh && fresh.status === 200) {
        await cache.put(url, fresh);
        replaced += 1;
      }
    }
  }
  return replaced;
}
