import { useMutation } from "@tanstack/react-query";
import { refreshTransitItinerary, type TransitRefreshResult } from "../../api/transit";

export type { TransitRefreshResult };

/**
 * Thin wrapper over `refreshTransitItinerary`. The rotating token is one-time,
 * so the mutation deliberately does not retry: a replayed token may already be
 * spent, and the caller must decide whether to replan instead.
 */
export function useRefreshTransitItinerary() {
  return useMutation({
    mutationFn: (token: string) => refreshTransitItinerary(token),
  });
}
