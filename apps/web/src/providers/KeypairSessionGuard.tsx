"use client";

import { MANGROVE_KEYPAIR_QUERY_KEY, useKeypairStore } from "@openmapx/mangrove-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect } from "react";
import { useSettledSessionAuthority } from "./SessionAuthorityBoundary";

/** The existing authority boundary owns session settlement and remounting. */
export function KeypairSessionGuard() {
  const { authorityKey } = useSettledSessionAuthority();
  const queryClient = useQueryClient();
  useLayoutEffect(() => {
    useKeypairStore.getState().bindOwner(authorityKey);
    return () => {
      // Invalidate delayed crypto and network completions before the next owner mounts.
      useKeypairStore.getState().bindOwner(null);
      queryClient.removeQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    };
  }, [authorityKey, queryClient]);
  return null;
}
