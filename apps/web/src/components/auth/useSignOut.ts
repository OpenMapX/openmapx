"use client";

import { authClient } from "@openmapx/core";
import {
  MANGROVE_KEYPAIR_QUERY_KEY,
  useKeypairStore,
  useMangroveSigner,
} from "@openmapx/mangrove-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { clearSignOutWebStorage } from "@/lib/signOutStorage";

/** Signs out, wiping the review-signing keys first. Shared by every sign-out entry. */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  const signer = useMangroveSigner();
  return useCallback(async () => {
    // Wipe the in-memory Mangrove keypair and its query-cached envelope before
    // tearing down the session so the private JWK isn't reachable through
    // application state afterwards. The server is the source of truth for the
    // encrypted envelope — we only hold decrypted material while a session is
    // live.
    useKeypairStore.getState().clear();
    queryClient.removeQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    const revocation = signer.controller?.disconnect();
    clearSignOutWebStorage();
    if (revocation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          revocation.catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await authClient.signOut();
  }, [queryClient, signer]);
}
