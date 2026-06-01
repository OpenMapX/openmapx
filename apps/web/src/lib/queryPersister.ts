"use client";

import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { idbDelete, idbGet, idbSet } from "./idbStore";
import { isRecentMapDataCacheEnabled } from "./recentMapDataCache";

/**
 * React Query persister backed by IndexedDB instead of localStorage, so the
 * persisted cache no longer competes for the ~5–10 MB localStorage budget.
 *
 * Honours the recent-map-data opt-in exactly like the previous localStorage
 * persister (nothing is written or restored while the cache is off), and
 * migrates a pre-existing localStorage blob into IndexedDB on first restore.
 */
export function createIdbPersister(key: string): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PersistedClient | null = null;

  const flush = async () => {
    timer = null;
    const client = pending;
    pending = null;
    if (!client) return;
    // The user may have turned the cache off between throttle ticks.
    if (!isRecentMapDataCacheEnabled()) {
      await idbDelete(key);
      return;
    }
    await idbSet(key, client);
  };

  return {
    persistClient(client: PersistedClient) {
      pending = client;
      if (!timer) timer = setTimeout(() => void flush(), 1000);
    },

    async restoreClient() {
      if (!isRecentMapDataCacheEnabled()) return undefined;
      let client = await idbGet<PersistedClient>(key);

      // One-time migration of the legacy localStorage blob.
      if (!client && typeof localStorage !== "undefined") {
        const legacy = localStorage.getItem(key);
        if (legacy) {
          try {
            client = JSON.parse(legacy) as PersistedClient;
            await idbSet(key, client);
          } catch {
            client = undefined;
          }
          localStorage.removeItem(key);
        }
      }

      return client ?? undefined;
    },

    async removeClient() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      await idbDelete(key);
    },
  };
}
