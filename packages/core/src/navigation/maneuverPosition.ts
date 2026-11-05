import type { LngLat } from "../types/geometry";
import type { Route } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import { cumulativeDistances } from "./deadReckon";
import { type PreparedRouteMatcher, prepareRouteMatcher, snapPreparedRoute } from "./routeMatcher";

export interface ManeuverPositions {
  starts: number[];
  ends: number[];
  total: number;
  metric: "geometry" | "engine-fallback";
}
const prepared = new WeakMap<Route, ManeuverPositions>();

/** Ordered physical maneuver occurrences; immutable route objects share the preparation. */
export function prepareManeuverPositions(route: Route): ManeuverPositions {
  const cached = prepared.get(route);
  if (cached) return cached;
  const usableGeometry =
    route.geometry.length >= 2 && route.steps.some((s) => (s.coordinates?.length ?? 0) > 0);
  const cum = usableGeometry ? cumulativeDistances(route.geometry) : [];
  const total = usableGeometry ? cum[cum.length - 1] : Math.max(0, route.distance);
  let engine = 0;
  const starts = usableGeometry
    ? stepGeometryDistances(route, cum)
    : route.steps.map((step) => {
        const start = engine;
        engine += step.distance;
        return start;
      });
  for (let i = 0; i < starts.length; i++)
    starts[i] = Math.max(i ? starts[i - 1] : 0, Math.min(total, starts[i]));
  const ends = starts.map((_, i) => starts[i + 1] ?? total);
  const result: ManeuverPositions = {
    starts,
    ends,
    total,
    metric: usableGeometry ? "geometry" : "engine-fallback",
  };
  prepared.set(route, result);
  return result;
}

export function maneuverStartMeters(route: Route, stepIndex: number): number {
  return prepareManeuverPositions(route).starts[stepIndex] ?? prepareManeuverPositions(route).total;
}

/** Match step shapes in route order, so repeated coordinates retain their occurrence. */
function stepGeometryDistances(route: Route, cum: number[]): number[] {
  const geometry = route.geometry;
  const coordinateKey = ([lng, lat]: LngLat): string => `${lng},${lat}`;
  const keys: string[] = [];
  const groupCoordinates: LngLat[] = [];
  const stepGroups = route.steps.map((step) =>
    (step.coordinates ?? []).map((coordinate) => {
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
  let confirmedAlongMeters = 0;
  let confirmedIndex = 0;
  let missingShape = false;
  let hasShapeEnd = false;
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

  const starts = route.steps.map<number | undefined>((step, stepIndex) => {
    const coordinates = step.coordinates ?? [];
    let alongMeters = confirmedAlongMeters;
    if (coordinates.length === 0) {
      const start =
        stepIndex === 0 ? 0 : !missingShape && hasShapeEnd ? confirmedAlongMeters : undefined;
      // Retain a distance hint for repeated visits; it cannot replace known boundaries.
      missingShape = true;
      advance(matchedAlongMeters + step.distance);
      return start;
    }
    for (let i = 0; i < coordinates.length; i += 1) {
      const coordinate = coordinates[i];
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
    hasShapeEnd = coordinates.length > 1 || step.distance === 0;
    return alongMeters;
  });
  // Missing boundaries are relative to the surrounding physical anchors. An
  // absolute engine prefix would move later confirmed coordinates during clamping.
  let left = 0;
  for (let right = 1; right <= starts.length; right += 1) {
    if (right < starts.length && starts[right] === undefined) continue;
    const from = starts[left]!;
    const to = starts[right] ?? cum[cum.length - 1];
    let distance = 0;
    for (let i = left; i < right; i += 1) distance += route.steps[i].distance;
    let traveled = 0;
    for (let i = left + 1; i < right; i += 1) {
      traveled += route.steps[i - 1].distance;
      starts[i] = from + (to - from) * (distance > 0 ? traveled / distance : 0);
    }
    left = right;
  }
  return starts as number[];
}
