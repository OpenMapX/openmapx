import type { JunctionDecisionPoint, JunctionKind } from "../types/junction";
import type { Route } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference } from "./bearing";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { resolveRecommendedLanes } from "./lanes";
import { stepStartMeters } from "./progress";

/**
 * Route-derived motorway decision points. Everything here reads `RouteStep`
 * alone (maneuver type, motorway flag, sign, lanes, geometry) so detection
 * works offline and on OSRM-served routes, with no network on the per-fix path.
 */

/** Maneuvers that can be a motorway decision. Valhalla ramps/exits normalise to `fork`. */
const DECISION_TYPES = new Set(["fork", "keep", "off ramp"]);

/** How far upstream of the point the approach bearing is read. */
const APPROACH_BEARING_OFFSET_METERS = 100;

/** Geometry offsets for the divergence fallback when the engine sent no bearings. */
const DIVERGENCE_OFFSET_METERS = 50;

/**
 * Find every motorway decision point (exit, fork, split) on a ground route.
 * Roundabouts, merges, plain turns and arrivals are never decision points; a
 * `keep` on a motorway counts as a fork even where the split is only a lane
 * drop — the panel's sign/gantry gating hides those without anything to draw.
 */
export function findJunctionDecisionPoints(route: Route): JunctionDecisionPoint[] {
  if (route.mode !== "driving" && route.mode !== "motorcycle") return [];
  const geometry = route.geometry;
  if (geometry.length < 2) return [];
  const cum = cumulativeDistances(geometry);
  const points: JunctionDecisionPoint[] = [];
  for (let i = 1; i < route.steps.length; i += 1) {
    const maneuverType = route.steps[i].maneuver?.type ?? "";
    if (!DECISION_TYPES.has(maneuverType)) continue;
    // A decision is only a decision once you are on the motorway: the previous
    // step drives on it, or is itself a decision (a split further along an exit
    // ramp). Reached from an ordinary road it is an on-ramp instead — and a
    // junction number is no help, because on-ramps carry the same number as the
    // exit ("Take exit 16 onto A 57"). Exits off a trunk road, which the engine
    // never flags, are offered by `findJunctionCandidates` for OSM to confirm.
    const fromMotorway =
      route.steps[i - 1]?.motorway === true || points.at(-1)?.stepIndex === i - 1;
    if (!fromMotorway) continue;
    points.push(buildDecisionPoint(route, cum, i));
  }
  return points;
}

/** Candidate maneuvers: a branch taken off a road. A `keep` is a split between streets too often. */
const CANDIDATE_TYPES = new Set(["fork", "off ramp"]);

/**
 * Forks the engine gave no motorway evidence for — exits off a trunk road
 * look exactly like an on-ramp's fork from a town street. They are only
 * candidates: the junctions lookup promotes one when OpenStreetMap shows a
 * motorway or trunk carriageway running through the split in the route's
 * direction, which a town street never is.
 */
export function findJunctionCandidates(route: Route): JunctionDecisionPoint[] {
  if (route.mode !== "driving" && route.mode !== "motorcycle") return [];
  if (route.geometry.length < 2) return [];
  const accepted = new Set(findJunctionDecisionPoints(route).map((point) => point.stepIndex));
  const cum = cumulativeDistances(route.geometry);
  return route.steps.flatMap((step, i) =>
    i >= 1 && CANDIDATE_TYPES.has(step.maneuver?.type ?? "") && !accepted.has(i)
      ? [buildDecisionPoint(route, cum, i)]
      : [],
  );
}

/** How far apart two routes may place the same junction's decision point. */
const SAME_JUNCTION_METERS = 20;
/** How far their approach bearings may differ. */
const SAME_JUNCTION_BEARING_DEG = 30;

/**
 * Whether two decision points, typically from a route and its replacement,
 * are the same junction approached the same way. Step indices differ between
 * routes, so the position, the approach and the side decide.
 */
export function sameJunction(a: JunctionDecisionPoint, b: JunctionDecisionPoint): boolean {
  return (
    a.side === b.side &&
    haversineDistance(a.point, b.point) <= SAME_JUNCTION_METERS &&
    angularDifference(a.approachBearing, b.approachBearing) <= SAME_JUNCTION_BEARING_DEG
  );
}

/** The decision point at step `i`: position, approach bearing, split angle and lanes. */
function buildDecisionPoint(route: Route, cum: number[], i: number): JunctionDecisionPoint {
  const geometry = route.geometry;
  const step = route.steps[i];
  const maneuverType = step.maneuver?.type ?? "";
  const hasExitNumber = (step.sign?.exitNumbers?.length ?? 0) > 0;
  const kind: JunctionKind =
    maneuverType === "fork" || maneuverType === "off ramp" || hasExitNumber ? "exit" : "fork";
  const modifier = step.maneuver?.modifier ?? "";
  const side: "left" | "right" = modifier.includes("left") ? "left" : "right";
  const alongMeters = stepStartMeters(route.steps, i);
  const point = positionAt(geometry, cum, alongMeters).point;
  const approachBearing = positionAt(
    geometry,
    cum,
    Math.max(alongMeters - APPROACH_BEARING_OFFSET_METERS, 0),
  ).bearing;
  // Positive divergence = the ramp peels right. Engine bearings first; the
  // geometry either side of the point stands in when the engine sent none.
  const divergenceDeg =
    step.bearingBefore !== undefined && step.bearingAfter !== undefined
      ? normalizeSigned(step.bearingAfter - step.bearingBefore)
      : normalizeSigned(
          positionAt(geometry, cum, alongMeters + DIVERGENCE_OFFSET_METERS).bearing -
            positionAt(geometry, cum, Math.max(alongMeters - DIVERGENCE_OFFSET_METERS, 0)).bearing,
        );
  return {
    stepIndex: i,
    kind,
    side,
    point,
    alongMeters,
    approachBearing,
    divergenceDeg,
    ...(step.lanes?.length ? { laneCount: step.lanes.length } : {}),
    activeLanes: activeLaneIndices(step),
    ...(step.sign ? { sign: step.sign } : {}),
  };
}

/** Normalise a signed delta to (−180, 180]. */
function normalizeSigned(delta: number): number {
  const wrapped = ((delta + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** Indices of the lanes the engine (or the maneuver fallback) marks valid. */
function activeLaneIndices(step: Route["steps"][number]): number[] {
  const resolved = resolveRecommendedLanes(step.lanes, step.maneuver);
  return resolved.flatMap((lane, i) => (lane.valid ? [i] : []));
}
