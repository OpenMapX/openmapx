"use client";

import { useSession } from "@openmapx/core";
import { MANGROVE_KEYPAIR_QUERY_KEY, useKeypairStore } from "@openmapx/mangrove-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * Wipes the in-memory Mangrove keypair and evicts its query-cached envelope
 * whenever the Better Auth session leaves the currently-tracked user — either
 * signing out, or switching to a different authenticated user id (account
 * switch, impersonation). The explicit teardown on sign-out still fires; this
 * handler covers silent transitions (expiry, cookie deletion, revocation from
 * another tab) and user swaps that never pass through the signed-out state.
 *
 * Mounted once at the app root so it runs for the whole session regardless
 * of which screens are active.
 */
export function KeypairSessionGuard() {
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    const currentUserId = session?.user?.id ?? null;
    if (lastUserId.current && lastUserId.current !== currentUserId) {
      useKeypairStore.getState().clear();
      queryClient.removeQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    }
    lastUserId.current = currentUserId;
  }, [session, isPending, queryClient]);

  return null;
}
