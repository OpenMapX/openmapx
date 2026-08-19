import { appShellCacheNames } from "@/lib/swCaches";

/**
 * Set the next-intl locale cookie and reload the page.
 * Shared by the settings dialog and command palette.
 *
 * Pages are cached in the service worker's `pages` cache keyed by URL only;
 * the locale lives in a cookie, so cached HTML for the previous language
 * could otherwise leak into the new session for up to the cache TTL. We wipe
 * the runtime page cache and refresh shell entries in whichever build-versioned
 * app-shell caches are present before reloading.
 */
export async function setLocaleAndReload(newLocale: string): Promise<void> {
  // biome-ignore lint/suspicious/noDocumentCookie: next-intl locale cookie must be set synchronously before reload
  document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
  if (typeof caches !== "undefined") {
    try {
      // Bust the runtime HTML cache — entries are URL-keyed and would
      // otherwise serve the previous locale.
      await caches.delete("pages");

      // Refresh the app-shell entries with the new locale. The SW `install`
      // handler is the only other populator and won't re-run on a locale
      // change, so wiping app-shell entirely would leave the navigation
      // fallback broken until the next deploy. We overwrite in place with
      // freshly-localized responses (the cookie is already set, so HTML
      // renders in the new locale).
      const shellNames = await appShellCacheNames();
      const refreshed = await Promise.all(
        ["/", "/offline"].map(async (url) => ({
          url,
          resp: await fetch(url, { cache: "reload" }),
        })),
      );
      await Promise.all(
        shellNames.map(async (name) => {
          const shell = await caches.open(name);
          await Promise.all(
            refreshed.map(({ url, resp }) => (resp.ok ? shell.put(url, resp.clone()) : undefined)),
          );
        }),
      );
    } catch {
      // best-effort — locale change must not block on cache surgery
    }
  }
  window.location.reload();
}
