import { useMutation } from "@tanstack/react-query";
import { refreshTransitItinerary, type TransitRefreshResult } from "../../api/transit";
import type { MutationHookOptions } from "../mutationErrorDisplay";

export type { TransitRefreshResult };

/**
 * Thin wrapper over `refreshTransitItinerary`. The rotating token is one-time,
 * so the mutation leaves retries to the navigation owner. The server can replay
 * a successful response for two minutes; terminal answers require rider recovery.
 */
export function useRefreshTransitItinerary(options: MutationHookOptions = {}) {
  return useMutation({
    ...options,
    mutationFn: (token: string) => refreshTransitItinerary(token),
  });
}
