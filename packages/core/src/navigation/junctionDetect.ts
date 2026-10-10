import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint, JunctionKind } from "../types/junction";
import type { Route } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference } from "./bearing";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { resolveRecommendedLanes } from "./lanes";
import { type PreparedRouteMatcher, prepareRouteMatcher, snapPreparedRoute } from "./routeMatcher";

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
  if (!route.steps.some((step) => DECISION_TYPES.has(step.maneuver?.type ?? ""))) return [];
  const cum = cumulativeDistances(geometry);
  const starts = stepGeometryDistances(route, cum);
  return decisionPoints(route, cum, starts);
}

function decisionPoints(route: Route, cum: number[], starts: number[]): JunctionDecisionPoint[] {
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
    points.push(buildDecisionPoint(route, cum, i, starts[i]));
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
  if (!route.steps.some((step) => CANDIDATE_TYPES.has(step.maneuver?.type ?? ""))) return [];
  const cum = cumulativeDistances(route.geometry);
  const starts = stepGeometryDistances(route, cum);
  const accepted = new Set(decisionPoints(route, cum, starts).map((point) => point.stepIndex));
  return route.steps.flatMap((step, i) =>
    i >= 1 && CANDIDATE_TYPES.has(step.maneuver?.type ?? "") && !accepted.has(i)
      ? [buildDecisionPoint(route, cum, i, starts[i])]
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
function buildDecisionPoint(
  route: Route,
  cum: number[],
  i: number,
  alongMeters: number,
): JunctionDecisionPoint {
  const geometry = route.geometry;
  const step = route.steps[i];
  const maneuverType = step.maneuver?.type ?? "";
  const hasExitNumber = (step.sign?.exitNumbers?.length ?? 0) > 0;
  const kind: JunctionKind =
    maneuverType === "fork" || maneuverType === "off ramp" || hasExitNumber ? "exit" : "fork";
  const modifier = step.maneuver?.modifier ?? "";
  const side: "left" | "right" = modifier.includes("left") ? "left" : "right";
  const point = step.coordinates[0] ?? positionAt(geometry, cum, alongMeters).point;
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

/** Match step shapes in route order, so repeated coordinates retain their occurrence. */
function stepGeometryDistances(route: Route, cum: number[]): number[] {
  const geometry = route.geometry;
  const coordinateKey = ([lng, lat]: LngLat): string => `${lng},${lat}`;
  const keys: string[] = [];
  const groupCoordinates: LngLat[] = [];
  const stepGroups = route.steps.map((step) =>
    step.coordinates.map((coordinate) => {
      const key = coordinateKey(coordinate);
      if (key !== keys.at(-1)) {
        keys.push(key);
        groupCoordinates.push(coordinate);
      }
      return keys.length - 1;
    }),
  );
  const occurrences = new Map<string, number[]>();
  keys.forEach((key, i) => {
    const indices = occurrences.get(key) ?? [];
    indices.push(i);
    occurrences.set(key, indices);
  });
  const anchors = new Array<number | undefined>(keys.length);
  const geometryVertices = new Map<string, number[]>();
  let previousGroup = -1;
  let previousDistance = -1;
  for (let i = 0; i < geometry.length; i += 1) {
    const key = coordinateKey(geometry[i]);
    const vertices = geometryVertices.get(key) ?? [];
    vertices.push(i);
    geometryVertices.set(key, vertices);
    const indices = occurrences.get(key);
    if (!indices) continue;
    const minimum = cum[i] === previousDistance ? previousGroup : previousGroup + 1;
    let lo = 0;
    let hi = indices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (indices[mid] < minimum) lo = mid + 1;
      else hi = mid;
    }
    const group = indices[lo];
    if (group === undefined) continue;
    anchors[group] = i;
    previousGroup = group;
    previousDistance = cum[i];
  }
  // Overview vertices are ordered anchors in the full step shape. Coordinates
  // omitted by simplification belong before their next anchor, even on a loop.
  const nextAnchor = new Array<number>(keys.length);
  let next = geometry.length - 1;
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    nextAnchor[i] = next;
    const anchor = anchors[i];
    if (anchor !== undefined) next = anchor;
  }
  const projections = new Map<number, { start: number; prepared: PreparedRouteMatcher }>();
  let geometryIndex = 0;
  let matchedAlongMeters = 0;
  let engineAlongMeters = 0;
  let confirmedAlongMeters = 0;
  let confirmedIndex = 0;
  let missingShape = false;
  let shapeDistances: number[] | undefined;
  const nearestVertex = (group: number, hint: number): number | undefined => {
    const indices = geometryVertices.get(keys[group]) ?? [];
    let lo = 0;
    let hi = indices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[indices[mid]] < hint) lo = mid + 1;
      else hi = mid;
    }
    let vertex: number | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const candidate of [indices[lo - 1], indices[lo]]) {
      if (candidate === undefined || cum[candidate] < confirmedAlongMeters - 1e-6) continue;
      const difference = Math.abs(cum[candidate] - hint);
      if (difference < nearest) {
        nearest = difference;
        vertex = candidate;
      }
    }
    return vertex;
  };
  const advance = (alongMeters: number): void => {
    matchedAlongMeters = Math.max(matchedAlongMeters, Math.min(alongMeters, cum[cum.length - 1]));
    while (geometryIndex < geometry.length - 1 && cum[geometryIndex + 1] <= matchedAlongMeters) {
      geometryIndex += 1;
    }
  };

  return route.steps.map((step, stepIndex) => {
    // Engine distances are only a fallback for steps without a usable coordinate.
    let alongMeters = engineAlongMeters;
    engineAlongMeters += step.distance;
    if (step.coordinates.length === 0) {
      // Retain fractional progress across missing shapes, including repeated visits.
      missingShape = true;
      advance(matchedAlongMeters + step.distance);
      return alongMeters;
    }
    for (let i = 0; i < step.coordinates.length; i += 1) {
      const coordinate = step.coordinates[i];
      const group = stepGroups[stepIndex][i];
      let vertex = anchors[group];
      let recoveryHint: number | undefined;
      let recoveryEnd: number | undefined;
      if (missingShape) {
        // Inferred progress is a hint, not a lower bound when coordinates resume.
        const hint = matchedAlongMeters;
        vertex = undefined;
        recoveryHint = hint;
        shapeDistances ??= cumulativeDistances(groupCoordinates);
        for (let following = group + 1; following < keys.length; following += 1) {
          const prefix = shapeDistances[following] - shapeDistances[group];
          const anchor = nearestVertex(following, hint + prefix);
          if (anchor === undefined) continue;
          anchors[following] = anchor;
          recoveryEnd = anchor;
          recoveryHint = Math.max(confirmedAlongMeters, cum[anchor] - prefix);
          break;
        }
        matchedAlongMeters = confirmedAlongMeters;
        geometryIndex = confirmedIndex;
        missingShape = false;
      }
      const upcoming = recoveryEnd ?? nextAnchor[group];
      const end =
        (recoveryHint !== undefined && recoveryEnd === undefined) ||
        cum[upcoming] < matchedAlongMeters - 1e-6
          ? geometry.length - 1
          : Math.max(geometryIndex, upcoming);
      let offset = matchedAlongMeters;
      if (vertex !== undefined && cum[vertex] >= matchedAlongMeters - 1e-6) {
        offset = cum[vertex];
      } else if (end > geometryIndex) {
        let projection = projections.get(end);
        if (!projection) {
          projection = {
            start: geometryIndex,
            prepared: prepareRouteMatcher(geometry.slice(geometryIndex, end + 1)),
          };
          projections.set(end, projection);
        }
        let snapped = snapPreparedRoute(
          projection.prepared,
          coordinate,
          geometryIndex - projection.start,
        );
        if (projection.start + snapped.segmentIndex < geometryIndex) {
          // A previous visit can be nearer; remove it once and reuse the remaining index.
          projection = {
            start: geometryIndex,
            prepared: prepareRouteMatcher(geometry.slice(geometryIndex, end + 1)),
          };
          projections.set(end, projection);
          snapped = snapPreparedRoute(projection.prepared, coordinate);
        }
        let segment = projection.start + snapped.segmentIndex;
        if (recoveryHint !== undefined) {
          let lo = geometryIndex;
          let hi = end - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (cum[mid] <= recoveryHint) lo = mid;
            else hi = mid - 1;
          }
          const preferred = snapPreparedRoute(
            prepareRouteMatcher(geometry.slice(lo, lo + 2)),
            coordinate,
          );
          // Geographically equal projections on repeated stretches use the recovered shape's offset.
          if (preferred.deviationMeters <= snapped.deviationMeters + 1e-6) {
            snapped = preferred;
            segment = lo + preferred.segmentIndex;
          }
        }
        if (segment === end) offset = cum[end];
        else {
          const length = cum[segment + 1] - cum[segment];
          const fraction =
            length > 0 ? haversineDistance(geometry[segment], snapped.snapped) / length : 0;
          // Use the geometry's metric, not the matcher's independent prefix sum.
          offset = cum[segment] + Math.min(fraction, 1) * length;
        }
      }
      advance(offset);
      confirmedAlongMeters = matchedAlongMeters;
      confirmedIndex = geometryIndex;
      if (i === 0) alongMeters = matchedAlongMeters;
    }
    return alongMeters;
  });
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
