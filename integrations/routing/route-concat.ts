import type { Route, RouteLeg, RouteStep } from "./types.js";

/** Coordinates within this many degrees of each other are the same point. */
const JOIN_EPSILON = 1e-9;

function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < JOIN_EPSILON && Math.abs(a[1] - b[1]) < JOIN_EPSILON;
}

/**
 * Fold per-leg routes into the single `Route` every existing consumer expects.
 *
 * Dwell and wait are deliberately excluded from `duration`: they belong to the
 * trip schedule, not to the driving time, and folding them in would make every
 * ETA and traffic-delay comparison downstream silently wrong.
 */
export function concatenateRoutes(routes: Route[]): Route {
  if (routes.length === 1) return routes[0];

  const geometry: [number, number][] = [];
  const legs: RouteLeg[] = [];
  const steps: RouteStep[] = [];
  const speedLimits: (number | null)[] = [];
  const elevation: number[] = [];
  let distance = 0;
  let duration = 0;
  let baseline = 0;

  const everyHasSpeedLimits = routes.every((route) => route.segmentSpeedLimits !== undefined);
  const everyHasBaseline = routes.every((route) => typeof route.baselineDuration === "number");
  const interval = routes[0].elevationInterval;
  const everyHasElevation = routes.every(
    (route) => route.elevation !== undefined && route.elevationInterval === interval,
  );

  for (const route of routes) {
    // The shared endpoint would otherwise appear twice and introduce a
    // zero-length segment, which breaks the 1:1 `segmentSpeedLimits` alignment
    // and confuses route snapping during navigation.
    const shape =
      geometry.length > 0 &&
      route.geometry.length > 0 &&
      samePoint(geometry[geometry.length - 1], route.geometry[0])
        ? route.geometry.slice(1)
        : route.geometry;
    geometry.push(...shape);
    legs.push(...route.legs);
    steps.push(...route.steps);
    distance += route.distance;
    duration += route.duration;
    if (everyHasBaseline) baseline += route.baselineDuration as number;
    if (everyHasSpeedLimits) speedLimits.push(...(route.segmentSpeedLimits as (number | null)[]));
    if (everyHasElevation) elevation.push(...(route.elevation as number[]));
  }

  return {
    distance,
    duration,
    ...(everyHasBaseline ? { baselineDuration: baseline } : {}),
    geometry,
    legs,
    steps,
    mode: routes[0].mode,
    ...(everyHasSpeedLimits ? { segmentSpeedLimits: speedLimits } : {}),
    ...(routes[0].summary ? { summary: routes[0].summary } : {}),
    ...(everyHasElevation && interval !== undefined
      ? { elevation, elevationInterval: interval }
      : {}),
  };
}
