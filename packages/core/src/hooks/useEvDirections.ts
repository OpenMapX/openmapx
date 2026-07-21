import { useQuery } from "@tanstack/react-query";
import { postEvDirections } from "../api/directions";
import type { EvDirectionsRequest } from "../types/routing";

/**
 * The single source of truth for the EV directions query key. Any component
 * reading the EV plan cache must build its key with this so the keys can
 * never drift apart.
 */
export function evDirectionsQueryKey(req: EvDirectionsRequest | null) {
  return ["ev-directions", req] as const;
}

/**
 * Fetch an EV route with charge stops inserted. Disabled until a request with
 * at least an origin and destination is available.
 */
export function useEvDirections(req: EvDirectionsRequest | null) {
  return useQuery({
    queryKey: evDirectionsQueryKey(req),
    queryFn: () => postEvDirections(req as EvDirectionsRequest),
    enabled: req != null && req.waypoints.length >= 2,
  });
}
