import {
  contributorsForField,
  type FieldContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { LngLat } from "../types/geometry";
import type { DirectionsResult, Route } from "../types/routing";
import type { RouteMatcherInput } from "./routeMatcher";
import {
  projectWaypointAfter,
  type WaypointOccurrence as RouteStopWaypointPosition,
  resolveWaypointOccurrences as routeStopWaypointPositions,
} from "./waypointOccurrences";

export { type RouteStopWaypointPosition, routeStopWaypointPositions };

export const ROUTE_STOP_LIMIT = 6;
export const ROUTE_STOP_CONCURRENCY = 2;
export const ROUTE_STOP_PROGRESS_METERS = 500;
export const ROUTE_STOP_CACHE_MS = 60_000;

export interface RouteStopCandidate {
  id: string;
  coordinates: LngLat;
  /** Explicit routable entrance supplied by a source, never inferred from a centroid. */
  routingEntrance?: LngLat;
}

interface RouteStopDetourBase {
  id: string;
  access: { kind: "entrance" | "coordinate"; coordinates: LngLat };
  waypoints: LngLat[];
  fieldContributors?: FieldContributors;
}

export type RouteStopDetour = RouteStopDetourBase &
  (
    | { kind: "network"; meters: number; seconds: number; provider: string }
    | { kind: "unknown" | "unreachable" }
  );

export function routeStopAccess(candidate: RouteStopCandidate): RouteStopDetour["access"] {
  return candidate.routingEntrance
    ? { kind: "entrance", coordinates: candidate.routingEntrance }
    : { kind: "coordinate", coordinates: candidate.coordinates };
}

export function remainingRouteStopWaypoints(
  positions: readonly RouteStopWaypointPosition[],
  from: LngLat,
  alongMeters: number,
): LngLat[] {
  return [
    from,
    ...positions
      .filter((wp) => wp.final || wp.alongMeters > alongMeters)
      .map((wp) => wp.coordinates),
  ];
}

/**
 * The index in `remaining` before which `target` is inserted: before the next
 * original stop beyond the target's position on the route, retaining user
 * order. -1 when there is no itinerary to insert into.
 */
export function routeStopInsertIndex(
  route: RouteMatcherInput,
  remaining: LngLat[],
  target: LngLat,
  fromAlongMeters = 0,
): number {
  if (remaining.length < 2) return -1;
  if (remaining.length === 2) return 1;
  const along = projectWaypointAfter(route, target, fromAlongMeters).alongMeters;
  const positions = routeStopWaypointPositions(route, remaining, fromAlongMeters);
  for (let i = 1; i < remaining.length - 1; i++) {
    if (positions[i - 1].alongMeters > along) return i;
  }
  return remaining.length - 1;
}

/** Insert before the next original stop beyond this target, retaining user order. */
export function insertRouteStop(
  route: RouteMatcherInput,
  remaining: LngLat[],
  target: LngLat,
  fromAlongMeters = 0,
): LngLat[] {
  const index = routeStopInsertIndex(route, remaining, target, fromAlongMeters);
  if (index < 0) return [];
  return [...remaining.slice(0, index), target, ...remaining.slice(index)];
}

export interface RouteStopRequest {
  waypoints: LngLat[];
  provider?: string;
  signal: AbortSignal;
}

export interface EvaluateRouteStopsInput {
  route: RouteMatcherInput;
  /** Reference progress on the original route, for repeated road coordinates. */
  alongMeters?: number;
  /** Already-pruned itinerary including its reference origin and final destination. */
  waypoints: LngLat[];
  candidates: readonly RouteStopCandidate[];
  provider?: string;
  signal: AbortSignal;
  /** The caller closes over the same mode, language and avoid/access options. */
  requestRoute: (request: RouteStopRequest) => Promise<DirectionsResult>;
  /**
   * The route the user already has and the provider that answered it. Stops
   * are then compared with that route (a selected alternative, not the
   * provider's fastest) and no baseline request is made.
   */
  baseline?: { route: Route; provider: string };
}

function checkAbort(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Route-stop evaluation cancelled");
  error.name = "AbortError";
  throw error;
}

function selectedRoute(result: DirectionsResult): Route | undefined {
  const route = result.routes?.[result.activeRouteIndex ?? 0];
  return route &&
    Number.isFinite(route.duration) &&
    route.duration >= 0 &&
    Number.isFinite(route.distance) &&
    route.distance >= 0
    ? route
    : undefined;
}

/** One baseline plus a bounded, concurrent shortlist; no matrix option assumptions. */
export async function evaluateRouteStopDetours(
  input: EvaluateRouteStopsInput,
): Promise<RouteStopDetour[]> {
  const { route, waypoints, signal, requestRoute } = input;
  checkAbort(signal);
  const results: RouteStopDetour[] = input.candidates
    .slice(0, ROUTE_STOP_LIMIT)
    .map((candidate) => {
      const access = routeStopAccess(candidate);
      return {
        id: candidate.id,
        kind: "unknown",
        access,
        waypoints: insertRouteStop(route, waypoints, access.coordinates, input.alongMeters),
      };
    });
  if (results.length === 0 || waypoints.length < 2) return results;
  let baseline: Route;
  let baselineFields: FieldContributors;
  let provider: string;
  if (input.baseline) {
    baseline = input.baseline.route;
    provider = input.baseline.provider;
    baselineFields = {
      duration: contributorsForField(baseline, "duration"),
      distance: contributorsForField(baseline, "distance"),
    };
  } else {
    try {
      const response = await requestRoute({ waypoints, provider: input.provider, signal });
      checkAbort(signal);
      const selected = selectedRoute(response);
      if (
        !selected ||
        !response.provider ||
        (input.provider && response.provider !== input.provider)
      )
        return results;
      baseline = selected;
      baselineFields = {
        duration: contributorsForField(selected, "duration"),
        distance: contributorsForField(selected, "distance"),
      };
      provider = response.provider;
    } catch {
      checkAbort(signal);
      return results;
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      checkAbort(signal);
      const index = next++;
      const result = results[index];
      try {
        const response = await requestRoute({ waypoints: result.waypoints, provider, signal });
        checkAbort(signal);
        if (response.provider !== provider) continue;
        const candidate = selectedRoute(response);
        if (!candidate) {
          if (Array.isArray(response.routes) && response.routes.length === 0)
            result.kind = "unreachable";
          continue;
        }
        results[index] = {
          ...result,
          kind: "network",
          provider,
          fieldContributors: {
            seconds: snapshotContributors(
              baselineFields.duration,
              contributorsForField(candidate, "duration"),
            ),
            meters: snapshotContributors(
              baselineFields.distance,
              contributorsForField(candidate, "distance"),
            ),
          },
          seconds: Math.max(0, candidate.duration - baseline.duration),
          meters: Math.max(0, candidate.distance - baseline.distance),
        };
      } catch {
        checkAbort(signal);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ROUTE_STOP_CONCURRENCY, results.length) }, worker),
  );
  return results;
}
