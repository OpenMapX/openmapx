"use client";

import {
  type PersistedQueryClientSaveOptions,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { isPersonalTimelineMutationKey } from "./personalTimelineCachePolicy";
import {
  isRecentMapDataCacheEnabled,
  isRecentMapDataQueryKey,
  subscribeRecentMapDataCacheChanges,
} from "./recentMapDataCache";

/** Schedule current-state snapshots before TanStack traverses the cache. */
export function subscribeRecentMapDataPersistence(
  options: PersistedQueryClientSaveOptions,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (!isRecentMapDataCacheEnabled() || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!isRecentMapDataCacheEnabled()) return;
      // Storage is best effort; a failed save must not interrupt query updates.
      void persistQueryClientSave(options).catch(() => {});
    }, 1000);
  };
  const isCacheChange = (type: string) =>
    type === "added" || type === "removed" || type === "updated";
  const unsubscribeQueries = options.queryClient.getQueryCache().subscribe((event) => {
    // Include failed/removed eligible queries so older successful data is erased.
    if (isCacheChange(event.type) && isRecentMapDataQueryKey(event.query.queryKey)) schedule();
  });
  const unsubscribeMutations = options.queryClient.getMutationCache().subscribe((event) => {
    if (
      isCacheChange(event.type) &&
      event.mutation &&
      !isPersonalTimelineMutationKey(event.mutation.options.mutationKey)
    )
      schedule();
  });
  const unsubscribePreference = subscribeRecentMapDataCacheChanges((reason) => {
    cancel();
    if (reason === "preference") schedule();
  });
  // Also capture already-loaded data when enabling persistence or restoring.
  schedule();
  return () => {
    cancel();
    unsubscribeQueries();
    unsubscribeMutations();
    unsubscribePreference();
  };
}
