"use client";

import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { idbDelete, idbGet, idbSet } from "./idbStore";
import {
  getRecentMapDataCacheGeneration,
  isRecentMapDataCacheEnabled,
  subscribeRecentMapDataCacheChanges,
} from "./recentMapDataCache";

/**
 * React Query persister backed by IndexedDB instead of localStorage, so the
 * persisted cache no longer competes for the ~5–10 MB localStorage budget.
 *
 * The cache subscription coalesces before dehydration, so this storage layer
 * writes immediately. Reads are invalidated by a clear or preference change.
 */
export function createIdbPersister(key: string): Persister {
  let removalGeneration = 0;

  return {
    async persistClient(client: PersistedClient) {
      if (!isRecentMapDataCacheEnabled()) return;
      await idbSet(key, client);
    },

    async restoreClient() {
      if (!isRecentMapDataCacheEnabled()) return undefined;
      const generation = getRecentMapDataCacheGeneration();
      const removal = removalGeneration;
      // Track other tabs' preferences during the read, before cache-event
      // subscriptions are installed after hydration.
      const unsubscribe = subscribeRecentMapDataCacheChanges(() => {});
      try {
        const client = await idbGet<PersistedClient>(key);
        if (
          !isRecentMapDataCacheEnabled() ||
          generation !== getRecentMapDataCacheGeneration() ||
          removal !== removalGeneration
        )
          return undefined;
        return client ?? undefined;
      } finally {
        unsubscribe();
      }
    },

    async removeClient() {
      removalGeneration += 1;
      await idbDelete(key);
    },
  };
}
