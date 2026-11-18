/** Upper bound for waiting on an idle period before warming anyway. */
const IDLE_TIMEOUT_MS = 10_000;
/** Delay used where `requestIdleCallback` is missing (Safari). */
const FALLBACK_DELAY_MS = 2_000;

const noop = () => {};

/**
 * Runs on-demand chunk loaders once the page is idle, so a dialog first opened
 * offline still loads from the service worker's `static-assets` cache (the
 * worker precaches no build chunks; see `sw.ts`).
 *
 * Only runs while a service worker controls the page. Without one there is no
 * offline cache to fill, and warming would just move the bytes the split saved.
 * Loader failures are ignored; opening the dialog retries the import.
 *
 * Returns a cleanup that cancels a warm-up that has not started yet.
 */
export function warmChunksOnIdle(loaders: ReadonlyArray<() => Promise<unknown>>): () => void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return noop;
  const run = () => {
    for (const load of loaders) void load().catch(noop);
  };
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => globalThis.cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, FALLBACK_DELAY_MS);
  return () => clearTimeout(timer);
}
