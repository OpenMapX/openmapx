"use client";

import { PERSONAL_TIMELINE_QUERY_KEY, usePersonalTimelineStore, useSession } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

/**
 * Clears all location-sensitive timeline memory before a changed session can
 * paint. Query keys are also owner-scoped, so the incoming user cannot observe
 * the previous owner's cache during the render that detects the transition.
 */
export function PersonalTimelineSessionGuard() {
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (isPending) return;

    const currentUserId = session?.user?.id ?? null;
    if (lastUserId.current && lastUserId.current !== currentUserId) {
      const mutationCache = queryClient.getMutationCache();
      for (const mutation of mutationCache.findAll({
        mutationKey: PERSONAL_TIMELINE_QUERY_KEY,
        exact: false,
      })) {
        mutationCache.remove(mutation);
      }
      void queryClient.cancelQueries({ queryKey: PERSONAL_TIMELINE_QUERY_KEY });
      queryClient.removeQueries({ queryKey: PERSONAL_TIMELINE_QUERY_KEY });
      usePersonalTimelineStore.getState().resetForSession();
    }
    lastUserId.current = currentUserId;
  }, [isPending, queryClient, session?.user?.id]);

  return null;
}
