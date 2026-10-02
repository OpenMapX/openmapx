import type { LngLat } from "../types/geometry";
import type {
  LocalizedText,
  RoadConditionEvent,
  RoadConditionSeverityLabel,
} from "../types/roadConditions";
import type { RouteStep } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
import { closesRoadForCars, effectInForceAt } from "../utils/roadConditionEffects";
import type { RoadAlert } from "./alerts";
import { angularDifference, bearingBetween, routeBearingAt } from "./bearing";
import {
  type PreparedRouteMatcher,
  prepareRouteMatcher,
  routeMatcherFor,
  snapPreparedRoute,
} from "./routeMatcher";

/** A road-condition event projected onto the active route as an approach alert. */
export interface IncidentAlert extends RoadAlert {
  type: "traffic_incident";
  /** Registry kind and type of the situation. */
  kind: string;
  eventType: string;
  severity: RoadConditionSeverityLabel;
  /** Where the situation came from; `crowd` marks a report a driver can vote on. */
  origin: RoadConditionEvent["origin"];
  headline?: LocalizedText;
  /** Provider display relationship, retained for route-layer grouping only. */
  groupId?: string;
  /** Estimated delay in seconds this incident adds, where the source reports it. */
  delaySeconds?: number;
  /** An effect in force at the evaluation instant closes the road to cars. */
  closesRoad: boolean;
  /** Original affected-road geometry, retained for navigation-map rendering. */
  geometry: RoadConditionEvent["geometry"];
  approach: { leadSec: number; minM: number; maxM: number };
}

/** Severity-scaled approach windows: critical incidents announce earlier/farther. */
const SEVERITY_APPROACH: Record<
  RoadConditionSeverityLabel,
  { leadSec: number; minM: number; maxM: number }
> = {
  critical: { leadSec: 30, minM: 600, maxM: 2500 },
  major: { leadSec: 20, minM: 400, maxM: 1500 },
  moderate: { leadSec: 14, minM: 250, maxM: 1000 },
  minor: { leadSec: 10, minM: 150, maxM: 600 },
  unknown: { leadSec: 12, minM: 200, maxM: 800 },
};

/** The delay a situation's delay effect in force at `at` reports, in seconds. */
function delaySecondsOf(event: RoadConditionEvent, at: Date): number | undefined {
  for (const effect of event.effects) {
    if (effect.kind !== "delay" || effect.delay?.unit !== "s") continue;
    if (effectInForceAt(event, effect, at)) return effect.delay.value;
  }
  return undefined;
}

/** Whether an effect of the situation in force at `at` closes the road to cars. */
function closesRoadAt(event: RoadConditionEvent, at: Date): boolean {
  return event.effects.some(
    (effect) => closesRoadForCars(effect) && effectInForceAt(event, effect, at),
  );
}

export interface ProjectEventsOptions {
  /** Maximum distance between affected geometry and the routed carriageway. */
  corridorMeters?: number;
  lookaheadMeters?: number;
  /** Route-step road names/refs used to reject nearby parallel roads. */
  routeSteps?: RouteStep[];
  /** Minimum sustained line overlap for long affected geometries. */
  minLineOverlapMeters?: number;
  directionToleranceDegrees?: number;
  /**
   * The caller's prepared index for `routeGeometry`. It belongs to the route,
   * not to any one call, so a caller ticking this repeatedly (e.g. navigation
   * re-evaluating incidents on every fix) should build it once when the route
   * is selected or replaced and pass the same object every time; omit it and
   * one is prepared (and cached) here instead.
   */
  routeMatcher?: PreparedRouteMatcher;
  /** The instant a situation's effects are evaluated at; default now. */
  now?: Date;
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

/** Every name and number a situation gives its roads, in every language. */
function eventRoadNames(event: RoadConditionEvent): Set<string> {
  return new Set(
    (event.roads ?? []).flatMap((road) => [
      ...(road.name ?? []).flatMap((name) => roadNameKeys(name.text)),
      ...(road.ref ? roadNameKeys(road.ref) : []),
    ]),
  );
}

/**
 * One prepared spherical index per eligible named step (road names present,
 * at least two coordinates), built once per {@link projectEventsToRoute} call
 * and reused by every event and every coordinate that call evaluates — never
 * rebuilt per event, per point, or per line sample. `prepareRouteMatcher`
 * itself caches on the step's coordinate array identity, so a route that is
 * re-evaluated across ticks with the same step objects builds nothing new
 * here either.
 */
function prepareStepMatchers(steps: RouteStep[] | undefined): Map<RouteStep, PreparedRouteMatcher> {
  const matchers = new Map<RouteStep, PreparedRouteMatcher>();
  if (!steps) return matchers;
  for (const step of steps) {
    if (!step.roadNames?.length || step.coordinates.length < 2) continue;
    matchers.set(step, prepareRouteMatcher(step.coordinates));
  }
  return matchers;
}

/** Road names/refs on the route steps closest to a candidate coordinate. */
function routeRoadNamesAt(
  steps: RouteStep[] | undefined,
  stepMatchers: Map<RouteStep, PreparedRouteMatcher>,
  coord: LngLat,
): Set<string> {
  if (!steps?.length) return new Set();
  const candidates: Array<{ deviation: number; names: string[] }> = [];
  for (const step of steps) {
    const matcher = stepMatchers.get(step);
    if (!matcher || !step.roadNames?.length) continue;
    const deviation = snapPreparedRoute(matcher, coord).deviationMeters;
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
  stepMatchers: Map<RouteStep, PreparedRouteMatcher>,
  coord: LngLat,
): boolean {
  if (eventNames.size === 0) return true;
  const routeNames = routeRoadNamesAt(routeSteps, stepMatchers, coord);
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

const COMPASS_BEARING: Record<string, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

/**
 * The direction a situation affects: both ways, a compass bearing, or a
 * direction the source named in words. A direction the source gave only
 * relative to the road (positive/negative) has no bearing here; on a line
 * situation, the line's own direction stands in for it.
 */
function eventDirection(event: RoadConditionEvent): EventDirection {
  const d = event.direction;
  if (!d || (d.value === "unknown" && !d.compass && !d.text)) {
    return { hasDirection: false, bidirectional: false, bearings: [] };
  }
  if (d.value === "both") return { hasDirection: true, bidirectional: true, bearings: [] };
  const bearing =
    d.compass !== undefined
      ? (COMPASS_BEARING[d.compass] ?? null)
      : d.text !== undefined
        ? cardinalBearing(d.text)
        : null;
  return { hasDirection: true, bidirectional: false, bearings: bearing === null ? [] : [bearing] };
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
  matcher: PreparedRouteMatcher,
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  stepMatchers: Map<RouteStep, PreparedRouteMatcher>,
  tolerance: number,
): RouteCandidate | null {
  const names = eventRoadNames(event);
  const direction = eventDirection(event);
  let best: RouteCandidate | null = null;
  for (const coord of flattenPositions(event.geometry)) {
    const snap = snapPreparedRoute(matcher, coord);
    if (snap.deviationMeters > corridor) continue;
    const ahead = snap.alongMeters - currentAlongMeters;
    if (ahead <= 0 || ahead > lookahead) continue;
    if (!roadMatches(names, routeSteps, stepMatchers, snap.snapped)) continue;
    const routeBearing = routeBearingAt(matcher.geometry, snap.segmentIndex);
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
  matcher: PreparedRouteMatcher,
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  stepMatchers: Map<RouteStep, PreparedRouteMatcher>,
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
        const snap = snapPreparedRoute(matcher, coord);
        if (snap.deviationMeters > corridor) continue;
        const routeBearing = routeBearingAt(matcher.geometry, snap.segmentIndex);
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
  return best &&
    matchedLength >= requiredOverlap &&
    roadMatches(names, routeSteps, stepMatchers, best.coord)
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

  // One index for the route, shared by every event this call evaluates, and
  // one per eligible named step, shared by every road-identity check any of
  // those events triggers — both hoisted out of the per-event loop so a
  // route with many events or a line event with many samples never rebuilds
  // either.
  const matcher = routeMatcherFor(routeGeometry, opts.routeMatcher);
  const stepMatchers = prepareStepMatchers(opts.routeSteps);
  const now = opts.now ?? new Date();

  const out: IncidentAlert[] = [];
  for (const event of events) {
    const lines = lineStrings(event.geometry);
    const candidate =
      lines.length > 0
        ? lineCandidate(
            event,
            lines,
            matcher,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            stepMatchers,
            minLineOverlap,
            tolerance,
          )
        : pointCandidate(
            event,
            matcher,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            stepMatchers,
            tolerance,
          );
    if (!candidate) continue;
    const delay = delaySecondsOf(event, now);
    out.push({
      id: event.id,
      type: "traffic_incident",
      coord: candidate.coord,
      alongMeters: candidate.alongMeters,
      kind: event.kind,
      eventType: event.type,
      severity: event.severity.label,
      origin: event.origin,
      ...(event.headline ? { headline: event.headline } : {}),
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(delay !== undefined ? { delaySeconds: delay } : {}),
      closesRoad: closesRoadAt(event, now),
      geometry: event.geometry,
      approach: SEVERITY_APPROACH[event.severity.label],
    });
  }
  out.sort((a, b) => a.alongMeters - b.alongMeters);
  return out;
}
