/**
 * Persistent-storage helpers.
 *
 * Without persistence, Cache Storage and — critically — the service-worker
 * registration are "best-effort": the browser may evict the whole origin under
 * storage pressure or after inactivity. Firefox on Android does this
 * aggressively, which is what breaks offline launch — once the SW registration
 * is reclaimed there's nothing left to serve the cached app shell, so
 * relaunching offline falls through to the network and the browser shows its
 * own connection-error page instead of the map. Requesting persistence exempts
 * the origin from automatic eviction. See `sw.ts` and the offline package store.
 */

function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.persist === "function" &&
    typeof navigator.storage.persisted === "function"
  );
}

/** Whether the browser exposes the Storage persistence API at all. */
export function persistentStorageSupported(): boolean {
  return supported();
}

/** Whether this origin's storage is already exempt from automatic eviction. */
export async function isStoragePersisted(): Promise<boolean> {
  if (!supported()) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Ask the browser to make this origin's storage persistent and resolve to the
 * resulting state. Safe to call repeatedly: if persistence is already granted
 * it returns `true` without re-prompting. Chrome grants silently for installed
 * PWAs / engaged origins; Firefox may show a one-time permission prompt, so
 * call this only from a meaningful context (installed PWA boot, or an explicit
 * offline package download action).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!supported()) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
