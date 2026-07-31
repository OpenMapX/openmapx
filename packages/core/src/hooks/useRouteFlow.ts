import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchRouteFlow } from "../api/roadConditions";
import { routeFingerprint } from "../navigation/flowProjection";
import type { RouteFlowInput, RouteFlowSpan } from "../types/roadConditions";

/** Refetch cadence, matched to the nav incident refresh so the two stay in step. */
const REFRESH_MS = 120_000;

/**
 * Identity of a set of routes for caching. Keyed on the id plus a fingerprint
 * of the whole polyline (not just its endpoints), via the same
 * `routeFingerprint` the server keys its flow cache with — two alternates
 * between the same origin and destination routinely share both ends and can
 * happen to sample the same number of points, so endpoints alone would let a
 * reroute (or picking a different alternate) silently reuse another route's
 * cached spans.
 */
export function routeFlowQueryKey(routes: RouteFlowInput[]): string[] {
  return routes.map((route) => `${route.id}:${routeFingerprint(route.geometry)}`);
}

/**
 * Live congestion along the drawn routes. Polled rather than fetched once: a
 * route stays on screen — or under the driver — far longer than traffic stays
 * current, and a frozen picture is worse than none.
 */
export function useRouteFlow(
  routes: RouteFlowInput[],
  enabled: boolean,
): Record<string, RouteFlowSpan[]> {
  // Hashing every point on each render would be wasted work once `routes` has
  // settled, so only recompute when the route array itself changes.
  const queryKey = useMemo(() => routeFlowQueryKey(routes), [routes]);
  const { data } = useQuery({
    queryKey: ["route-flow", ...queryKey],
    queryFn: () => fetchRouteFlow(routes),
    enabled: enabled && routes.length > 0,
    staleTime: 60_000,
    refetchInterval: REFRESH_MS,
  });
  return data ?? {};
}
