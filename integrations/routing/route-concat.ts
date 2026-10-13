import {
  contributorsForField,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import {
  captureGeometryContributors,
  type GeometryContributorSpan,
} from "@openmapx/mobility-core/geometry-contributors";
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

  const geometryContributors: GeometryContributorSpan[] = [];
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
  // One tolled leg tolls the trip; it is toll-free only when every leg says so.
  const hasTolls = routes.some((route) => route.hasTolls === true)
    ? true
    : routes.every((route) => route.hasTolls === false)
      ? false
      : undefined;
  const interval = routes[0].elevationInterval;
  const everyHasElevation = routes.every(
    (route) => route.elevation !== undefined && route.elevationInterval === interval,
  );
  const sourceIds = [...new Set(routes.flatMap((route) => route.sourceIds ?? []))];

  for (const route of routes) {
    // The shared endpoint would otherwise appear twice and introduce a
    // zero-length segment, which breaks the 1:1 `segmentSpeedLimits` alignment
    // and confuses route snapping during navigation.
    const hasJoin = geometry.length > 0 && route.geometry.length > 0;
    const sharedEndpoint = hasJoin && samePoint(geometry[geometry.length - 1], route.geometry[0]);
    const shape = sharedEndpoint ? route.geometry.slice(1) : route.geometry;
    const offset = geometry.length - (sharedEndpoint ? 1 : 0);
    if (hasJoin && !sharedEndpoint)
      geometryContributors.push({ startIndex: offset - 1, endIndex: offset, contributors: [] });
    geometryContributors.push(
      ...captureGeometryContributors(route).map((span) => ({
        ...span,
        startIndex: span.startIndex + offset,
        endIndex: span.endIndex + offset,
      })),
    );
    geometry.push(...shape);
    legs.push(...route.legs);
    steps.push(...route.steps);
    distance += route.distance;
    duration += route.duration;
    if (everyHasBaseline) baseline += route.baselineDuration as number;
    if (everyHasSpeedLimits) {
      // Unequal endpoints introduce a connecting segment with no known limit.
      if (hasJoin && !sharedEndpoint) speedLimits.push(null);
      speedLimits.push(...(route.segmentSpeedLimits as (number | null)[]));
    }
    if (everyHasElevation) elevation.push(...(route.elevation as number[]));
  }

  const retainedFields = new Set([
    "geometry",
    "distance",
    "duration",
    "legs",
    "steps",
    "mode",
    ...(routes[0].summary ? ["summary"] : []),
    ...(everyHasBaseline ? ["baselineDuration"] : []),
    ...(everyHasSpeedLimits ? ["segmentSpeedLimits"] : []),
    ...(hasTolls === undefined ? [] : ["hasTolls"]),
    ...(everyHasElevation && interval !== undefined ? ["elevation", "elevationInterval"] : []),
  ]);
  const fieldContributors = Object.fromEntries(
    [...retainedFields].map((field) => {
      const root = field.split(".")[0];
      const suppliers = ["summary", "mode", "elevationInterval"].includes(root)
        ? [routes[0]]
        : root === "hasTolls" && hasTolls === true
          ? routes.filter((route) => route.hasTolls === true)
          : routes;
      return [
        field,
        snapshotContributors(...suppliers.map((route) => contributorsForField(route, field))),
      ];
    }),
  );
  // Array indices are local to each input. Preserve child trees at their new
  // output positions instead of unioning unrelated legs/steps with equal indices.
  for (const root of ["legs", "steps"] as const) {
    let offset = 0;
    for (const route of routes) {
      route[root].forEach((child, index) => {
        const prefix = `${root}.${index}`;
        const target = `${root}.${offset + index}`;
        fieldContributors[target] =
          child.contributors !== undefined || child.fieldContributors !== undefined
            ? child.fieldContributors === undefined
              ? snapshotContributors(child.contributors ?? [])
              : []
            : contributorsForField(route, prefix);
        for (const [field, receipts] of Object.entries(
          child.contributors === undefined && child.fieldContributors === undefined
            ? (route.fieldContributors ?? {})
            : {},
        )) {
          if (field.startsWith(`${prefix}.`))
            fieldContributors[target + field.slice(prefix.length)] = snapshotContributors(receipts);
        }
        for (const [field, receipts] of Object.entries(child.fieldContributors ?? {}))
          fieldContributors[`${target}.${field}`] = snapshotContributors(receipts);
      });
      offset += route[root].length;
    }
  }
  return {
    geometryContributors,
    contributors: contributorsForRecords(routes),
    fieldContributors,
    distance,
    duration,
    ...(everyHasBaseline ? { baselineDuration: baseline } : {}),
    geometry,
    legs,
    steps,
    mode: routes[0].mode,
    ...(everyHasSpeedLimits ? { segmentSpeedLimits: speedLimits } : {}),
    ...(routes[0].summary ? { summary: routes[0].summary } : {}),
    ...(hasTolls === undefined ? {} : { hasTolls }),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(everyHasElevation && interval !== undefined
      ? { elevation, elevationInterval: interval }
      : {}),
  };
}
