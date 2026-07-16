import type { LngLat } from "../types/geometry";
import type {
  RoadConditionEvent,
  RoadConditionSeverity,
  RoadConditionType,
} from "../types/roadConditions";
import type { RouteStep } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import type { RoadAlert } from "./alerts";
import { snapToRoute } from "./snap";

/** A road-condition event projected onto the active route as an approach alert. */
export interface IncidentAlert extends RoadAlert {
  type: "traffic_incident";
  eventType: RoadConditionType;
  severity: RoadConditionSeverity;
  headline: string;
  approach: { leadSec: number; minM: number; maxM: number };
}

/** Severity-scaled approach windows: critical incidents announce earlier/farther. */
const SEVERITY_APPROACH: Record<
  RoadConditionSeverity,
  { leadSec: number; minM: number; maxM: number }
> = {
  critical: { leadSec: 30, minM: 600, maxM: 2500 },
  high: { leadSec: 20, minM: 400, maxM: 1500 },
  medium: { leadSec: 14, minM: 250, maxM: 1000 },
  low: { leadSec: 10, minM: 150, maxM: 600 },
  unknown: { leadSec: 12, minM: 200, maxM: 800 },
};

export interface ProjectEventsOptions {
  /** Maximum distance between affected geometry and the routed carriageway. */
  corridorMeters?: number;
  lookaheadMeters?: number;
  /** Route-step road names/refs used to reject nearby parallel roads. */
  routeSteps?: RouteStep[];
  /** Minimum sustained line overlap for long affected geometries. */
  minLineOverlapMeters?: number;
  directionToleranceDegrees?: number;
}

const DEFAULT_CORRIDOR_M = 20;
const DEFAULT_LOOKAHEAD_M = 25_000;
const DEFAULT_MIN_LINE_OVERLAP_M = 75;
const MIN_SHORT_LINE_OVERLAP_M = 8;
const LINE_OVERLAP_FRACTION = 0.25;
const MAX_SEGMENT_SAMPLES = 64;
const TARGET_SAMPLE_LENGTH_M = 30;
const DEFAULT_DIRECTION_TOLERANCE_DEG = 60;

interface RouteCandidate {
  coord: LngLat;
  alongMeters: number;
  routeBearing: number;
}

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Initial great-circle bearing a→b, degrees clockwise from north. */
function bearingBetween(a: LngLat, b: LngLat): number {
  const deltaLng = toRad(b[0] - a[0]);
  const y = Math.sin(deltaLng) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angularDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function routeBearingAt(route: LngLat[], segmentIndex: number): number {
  const index = Math.max(0, Math.min(segmentIndex, route.length - 2));
  const start = route[index];
  const end = route[index + 1];
  return start && end ? bearingBetween(start, end) : 0;
}

/** Every [lon,lat] position in a GeoJSON geometry (incl. GeometryCollection). */
function flattenPositions(geometry: RoadConditionEvent["geometry"]): LngLat[] {
  const out: LngLat[] = [];
  const walk = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      out.push([coordinates[0], coordinates[1]]);
      return;
    }
    for (const child of coordinates) walk(child);
  };
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) {
      for (const position of flattenPositions(child)) out.push(position);
    }
  } else {
    walk(geometry.coordinates);
  }
  return out;
}

/** Genuine affected-road line strings, excluding point endpoints and polygon rings. */
function lineStrings(geometry: RoadConditionEvent["geometry"]): LngLat[][] {
  if (geometry.type === "LineString") return [geometry.coordinates as LngLat[]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as LngLat[][];
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(lineStrings);
  return [];
}

function normalizeRoadName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function roadNameKeys(name: string): string[] {
  return [name, ...name.split(/[/,;|]/)]
    .map(normalizeRoadName)
    .filter((key, index, keys) => key.length > 0 && keys.indexOf(key) === index);
}

function eventRoadNames(event: RoadConditionEvent): Set<string> {
  return new Set((event.roads ?? []).flatMap((road) => roadNameKeys(road.name)));
}

/** Road names/refs on the route steps closest to a candidate coordinate. */
function routeRoadNamesAt(steps: RouteStep[] | undefined, coord: LngLat): Set<string> {
  if (!steps?.length) return new Set();
  const candidates: Array<{ deviation: number; names: string[] }> = [];
  for (const step of steps) {
    if (!step.roadNames?.length || step.coordinates.length < 2) continue;
    const deviation = snapToRoute(step.coordinates, coord).deviationMeters;
    candidates.push({ deviation, names: step.roadNames });
  }
  if (candidates.length === 0) return new Set();
  const closest = Math.min(...candidates.map((candidate) => candidate.deviation));
  return new Set(
    candidates
      .filter((candidate) => candidate.deviation <= closest + 5)
      .flatMap((candidate) => candidate.names)
      .flatMap(roadNameKeys),
  );
}

/** Reject only when both sides identify a road and those identities disagree. */
function roadMatches(
  eventNames: Set<string>,
  routeSteps: RouteStep[] | undefined,
  coord: LngLat,
): boolean {
  if (eventNames.size === 0) return true;
  const routeNames = routeRoadNamesAt(routeSteps, coord);
  if (routeNames.size === 0) return true;
  return [...eventNames].some((name) => routeNames.has(name));
}

interface EventDirection {
  hasDirection: boolean;
  bidirectional: boolean;
  bearings: number[];
}

function cardinalBearing(direction: string): number | null {
  const value = direction.trim().toLowerCase();
  if (/^(n|north|northbound|nord|nordwaerts|nordwärts)$/.test(value)) return 0;
  if (/^(e|east|eastbound|ost|ostwaerts|ostwärts)$/.test(value)) return 90;
  if (/^(s|south|southbound|sued|süd|suedwaerts|südwärts)$/.test(value)) return 180;
  if (/^(w|west|westbound|westwaerts|westwärts)$/.test(value)) return 270;
  return null;
}

function eventDirection(event: RoadConditionEvent): EventDirection {
  const raw = (event.roads ?? [])
    .map((road) => road.direction?.trim())
    .filter((direction): direction is string => Boolean(direction));
  if (raw.length === 0) return { hasDirection: false, bidirectional: false, bearings: [] };
  if (
    raw.some((direction) => /^(both|all|both directions|beide|beide richtungen)$/i.test(direction))
  ) {
    return { hasDirection: true, bidirectional: true, bearings: [] };
  }
  const bearings = raw
    .map(cardinalBearing)
    .filter((bearing): bearing is number => bearing !== null);
  const bidirectional = bearings.some((a) => bearings.some((b) => angularDifference(a, b) >= 120));
  return { hasDirection: true, bidirectional, bearings };
}

function directionMatches(
  direction: EventDirection,
  routeBearing: number,
  fallbackLineBearing: number | null,
  tolerance: number,
): boolean {
  if (!direction.hasDirection || direction.bidirectional) return true;
  if (direction.bearings.length > 0) {
    return direction.bearings.some(
      (incidentBearing) => angularDifference(incidentBearing, routeBearing) <= tolerance,
    );
  }
  // Some feeds use opaque direction codes (e.g. f/b). On line events, the
  // encoded line direction supplies the missing bearing; a point cannot.
  return (
    fallbackLineBearing === null ||
    angularDifference(fallbackLineBearing, routeBearing) <= tolerance
  );
}

function pointCandidate(
  event: RoadConditionEvent,
  route: LngLat[],
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  tolerance: number,
): RouteCandidate | null {
  const names = eventRoadNames(event);
  const direction = eventDirection(event);
  let best: RouteCandidate | null = null;
  for (const coord of flattenPositions(event.geometry)) {
    const snap = snapToRoute(route, coord);
    if (snap.deviationMeters > corridor) continue;
    const ahead = snap.alongMeters - currentAlongMeters;
    if (ahead <= 0 || ahead > lookahead) continue;
    if (!roadMatches(names, routeSteps, snap.snapped)) continue;
    const routeBearing = routeBearingAt(route, snap.segmentIndex);
    if (!directionMatches(direction, routeBearing, null, tolerance)) continue;
    if (!best || snap.alongMeters < best.alongMeters) {
      best = { coord, alongMeters: snap.alongMeters, routeBearing };
    }
  }
  return best;
}

function lineCandidate(
  event: RoadConditionEvent,
  lines: LngLat[][],
  route: LngLat[],
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  minLineOverlap: number,
  tolerance: number,
): RouteCandidate | null {
  const names = eventRoadNames(event);
  const direction = eventDirection(event);
  let totalLength = 0;
  let matchedLength = 0;
  let best: RouteCandidate | null = null;

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index++) {
      const start = line[index];
      const end = line[index + 1];
      if (!start || !end) continue;
      const segmentLength = haversineDistance(start, end);
      if (segmentLength <= 0) continue;
      totalLength += segmentLength;
      const samples = Math.min(
        MAX_SEGMENT_SAMPLES,
        Math.max(1, Math.ceil(segmentLength / TARGET_SAMPLE_LENGTH_M)),
      );
      const sampleLength = segmentLength / samples;
      const lineBearing = bearingBetween(start, end);
      for (let sample = 0; sample < samples; sample++) {
        const ratio = (sample + 0.5) / samples;
        const coord: LngLat = [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio,
        ];
        const snap = snapToRoute(route, coord);
        if (snap.deviationMeters > corridor) continue;
        const routeBearing = routeBearingAt(route, snap.segmentIndex);
        if (!directionMatches(direction, routeBearing, lineBearing, tolerance)) continue;
        matchedLength += sampleLength;
        const ahead = snap.alongMeters - currentAlongMeters;
        if (ahead <= 0 || ahead > lookahead) continue;
        if (!best || snap.alongMeters < best.alongMeters) {
          best = { coord, alongMeters: snap.alongMeters, routeBearing };
        }
      }
    }
  }

  const requiredOverlap = Math.min(
    minLineOverlap,
    Math.max(MIN_SHORT_LINE_OVERLAP_M, totalLength * LINE_OVERLAP_FRACTION),
  );
  return best && matchedLength >= requiredOverlap && roadMatches(names, routeSteps, best.coord)
    ? best
    : null;
}

/**
 * Match road-condition events to the actual routed carriageway. Line events
 * must overlap the route for a sustained distance; point events use a tight
 * corridor. When feeds provide road identities or travel direction, both must
 * agree with the nearest route step. This excludes adjacent exits, parallel
 * roads, and opposite motorway carriageways rather than treating a broad bbox
 * or a single nearest point as route relevance.
 */
export function projectEventsToRoute(
  events: RoadConditionEvent[],
  routeGeometry: LngLat[],
  currentAlongMeters: number,
  opts: ProjectEventsOptions = {},
): IncidentAlert[] {
  if (routeGeometry.length < 2) return [];
  const corridor = opts.corridorMeters ?? DEFAULT_CORRIDOR_M;
  const lookahead = opts.lookaheadMeters ?? DEFAULT_LOOKAHEAD_M;
  const minLineOverlap = opts.minLineOverlapMeters ?? DEFAULT_MIN_LINE_OVERLAP_M;
  const tolerance = opts.directionToleranceDegrees ?? DEFAULT_DIRECTION_TOLERANCE_DEG;

  const out: IncidentAlert[] = [];
  for (const event of events) {
    const lines = lineStrings(event.geometry);
    const candidate =
      lines.length > 0
        ? lineCandidate(
            event,
            lines,
            routeGeometry,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            minLineOverlap,
            tolerance,
          )
        : pointCandidate(
            event,
            routeGeometry,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            tolerance,
          );
    if (!candidate) continue;
    out.push({
      id: event.id,
      type: "traffic_incident",
      coord: candidate.coord,
      alongMeters: candidate.alongMeters,
      eventType: event.type,
      severity: event.severity,
      headline: event.headline,
      approach: SEVERITY_APPROACH[event.severity] ?? SEVERITY_APPROACH.unknown,
    });
  }
  out.sort((a, b) => a.alongMeters - b.alongMeters);
  return out;
}
