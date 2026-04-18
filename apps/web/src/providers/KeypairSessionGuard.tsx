"use client";

import { useKeypairStore, useSession } from "@openmapx/core";
import { useEffect, useRef } from "react";

/**
 * Wipes the in-memory Mangrove keypair whenever the Better Auth session
 * leaves the currently-tracked user — either signing out, or switching to
 * a different authenticated user id (account switch, impersonation). The
 * explicit `clear()` on sign-out still fires; this handler covers silent
 * transitions (expiry, cookie deletion, revocation from another tab) and
 * user swaps that never pass through the signed-out state.
 *
 * Mounted once at the app root so it runs for the whole session regardless
 * of which screens are active.
 */
export function KeypairSessionGuard() {
  const { data: session, isPending } = useSession();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    const currentUserId = session?.user?.id ?? null;
    if (lastUserId.current && lastUserId.current !== currentUserId) {
      useKeypairStore.getState().clear();
    }
    lastUserId.current = currentUserId;
  }, [session, isPending]);

  return null;
}
