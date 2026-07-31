import type { LngLat } from "../types/geometry";
import type { RoadFlowSegment, RouteFlowSpan } from "../types/roadConditions";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference, bearingBetween, routeBearingAt } from "./bearing";
import { snapToRoute } from "./snap";

export interface ProjectFlowOptions {
  /** Maximum distance from the routed carriageway for a sample to count. */
  corridorMeters?: number;
  /** Maximum heading disagreement; this is what separates the two carriageways. */
  directionToleranceDegrees?: number;
  /** Spans shorter than this are noise, not a jam. */
  minSpanMeters?: number;
  /** Same-level spans closer than this are one jam with a sampling hole. */
  mergeGapMeters?: number;
}

const DEFAULT_CORRIDOR_M = 25;
const DEFAULT_DIRECTION_TOLERANCE_DEG = 45;
const DEFAULT_MIN_SPAN_M = 40;
const DEFAULT_MERGE_GAP_M = 60;
const MAX_SEGMENT_SAMPLES = 24;

/**
 * How much further the route is allowed to travel than the segment's own
 * straight-line step, per metre of that step, before a run is considered
 * broken. Road curvature makes the along-route arc exceed the segment's
 * chord between two samples; that excess scales with the chord length (and
 * with curvature and sample spacing), not with the corridor width, so the
 * slack has to scale with the step rather than being a fixed distance.
 *
 * The bound this must clear: for any single convex bend, arc/chord ≤ π/2 ≈
 * 1.5708 — the semicircle is the extreme case (a 30° turn gives 1.012, 90°
 * gives 1.111, 150° gives 1.355, 180° gives 1.571). routeStep/segStep can
 * exceed that ratio only when the segment's geometry does not follow the
 * route's path between the two samples — exactly the shortcut this guard
 * targets — because when segment and route trace the same curve, routeStep
 * is that curve's arc and segStep is its chord, so the ratio is bounded by
 * π/2 regardless of how tight the curve is or how far apart the samples
 * fall. A factor below 1.5708 would therefore split a legitimate contiguous
 * match whenever the route turns more than about 172° between consecutive
 * samples — a hairpin switchback, a cloverleaf loop ramp, a mountain road —
 * opening a silent uncovered hole in the middle of a real jam. 2 clears the
 * bound with margin for the route polyline itself being a chord
 * approximation of the real road, and still splits a 100 m chord laid
 * across 400 m of route (threshold 250 < 400).
 */
const RUN_STEP_SLACK_FACTOR = 2;

const LOS_RANK: Record<string, number> = {
  free_flow: 0,
  unknown: 0,
  heavy: 2,
  queuing: 3,
  blocked: 4,
  stationary: 4,
};

/**
 * How bad a stretch is, on one scale, so overlapping observations resolve
 * deterministically. A measured ratio outranks the declared level when it is
 * worse — a segment declared `heavy` but measured at 15% of free flow is a
 * standstill, and painting it orange would understate it.
 */
export function flowSeverityRank(los: string, speedRatio?: number): number {
  const declared = LOS_RANK[los] ?? 0;
  if (speedRatio == null || !Number.isFinite(speedRatio)) return declared;
  const measured = speedRatio <= 0.25 ? 4 : speedRatio <= 0.5 ? 3 : speedRatio <= 0.75 ? 2 : 0;
  return Math.max(declared, measured);
}

/**
 * Stable, short checksum of a route polyline: length plus a djb2-style hash of
 * every coordinate. Shared between the server (`flowSpansForRoutes`'s cache
 * key) and the client (`useRouteFlow`'s query key) so the two can never drift
 * apart into keying the same route differently — a route's identity for
 * traffic-matching purposes is defined exactly once, here.
 */
export function routeFingerprint(geometry: readonly LngLat[]): string {
  let hash = 5381;
  for (const [lng, lat] of geometry) {
    hash = ((hash << 5) + hash + Math.round(lng * 1e5)) | 0;
    hash = ((hash << 5) + hash + Math.round(lat * 1e5)) | 0;
  }
  return `${geometry.length}:${(hash >>> 0).toString(36)}`;
}

/** Evenly spaced sample indices across a segment, always including both ends. */
function sampleIndices(count: number): number[] {
  if (count <= MAX_SEGMENT_SAMPLES) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (MAX_SEGMENT_SAMPLES - 1);
  return Array.from({ length: MAX_SEGMENT_SAMPLES }, (_, i) => Math.round(i * step));
}

interface RawSpan extends RouteFlowSpan {
  rank: number;
}

interface AcceptedSample {
  alongMeters: number;
  point: LngLat;
}

/**
 * Project one flow segment onto the route, emitting one span per contiguous
 * run of accepted samples rather than a single span from the first touch to
 * the last. A run ends when a sample fails the corridor or bearing test (the
 * segment has left the routed carriageway), or when the along-route distance
 * to the next accepted sample disagrees with the segment's own straight-line
 * distance between those two points by more than curvature and sampling can
 * explain. Two disconnection shapes need that second check, since neither
 * trips the corridor or bearing test on its own:
 *  - A route that loops back on itself, where a segment's samples all pass
 *    corridor and bearing but snap onto wildly different along-route
 *    distances — caught by the backward guard (`routeStep < -corridor`).
 *  - A coarse, straight two-point segment whose endpoints both sit inside
 *    the corridor but whose chord cuts across a route bend, so the segment
 *    looks contiguous yet would claim the whole bend — caught by the forward
 *    guard below, scaled by `RUN_STEP_SLACK_FACTOR` (see its doc comment).
 */
function segmentSpans(
  segment: RoadFlowSegment,
  routeGeometry: LngLat[],
  corridor: number,
  tolerance: number,
): RawSpan[] {
  const coords = segment.geometry.coordinates as LngLat[];
  if (coords.length < 2) return [];

  const rank = flowSeverityRank(segment.los, segment.speedRatio);
  const spans: RawSpan[] = [];
  let run: AcceptedSample[] = [];

  const closeRun = (): void => {
    if (run.length === 0) return;
    const alongs = run.map((s) => s.alongMeters);
    spans.push({
      startMeters: Math.min(...alongs),
      endMeters: Math.max(...alongs),
      los: segment.los,
      confidence: segment.confidence,
      rank,
      ...(segment.speedRatio !== undefined && { speedRatio: segment.speedRatio }),
      ...(segment.currentSpeedKph !== undefined && { currentSpeedKph: segment.currentSpeedKph }),
      ...(segment.freeFlowSpeedKph !== undefined && { freeFlowSpeedKph: segment.freeFlowSpeedKph }),
    });
    run = [];
  };

  for (const index of sampleIndices(coords.length)) {
    const point = coords[index];
    const snap = snapToRoute(routeGeometry, point);
    if (snap.deviationMeters > corridor) {
      closeRun();
      continue;
    }
    const ahead = coords[Math.min(index + 1, coords.length - 1)];
    const behind = coords[Math.max(index - 1, 0)];
    const segmentBearing = bearingBetween(behind, ahead);
    if (
      angularDifference(segmentBearing, routeBearingAt(routeGeometry, snap.segmentIndex)) >
      tolerance
    ) {
      closeRun();
      continue;
    }

    const previous = run[run.length - 1];
    if (previous) {
      const routeStep = snap.alongMeters - previous.alongMeters;
      const segStep = haversineDistance(previous.point, point);
      if (routeStep < -corridor || routeStep > segStep * RUN_STEP_SLACK_FACTOR + corridor * 2) {
        closeRun();
      }
    }
    run.push({ alongMeters: snap.alongMeters, point });
  }
  closeRun();

  return spans;
}

/** Whether two spans describe the same condition closely enough to merge. */
function sameCondition(a: RawSpan, b: RawSpan): boolean {
  if (a.los !== b.los) return false;
  const ratioA = a.speedRatio ?? -1;
  const ratioB = b.speedRatio ?? -1;
  return Math.abs(ratioA - ratioB) < 0.05;
}

/**
 * Match live flow segments onto a route polyline and return the stretches of
 * that route they cover, in metres along it. Overlaps resolve worst-first: a
 * standstill inside a wider heavy stretch stays visible as a standstill.
 *
 * Free-flow spans are returned like any other; suppressing them is a rendering
 * decision the caller makes, and keeping them here is what lets a free-flow
 * observation lose to a jam rather than silently disappear.
 */
export function projectFlowToRoute(
  segments: readonly RoadFlowSegment[],
  routeGeometry: LngLat[],
  opts: ProjectFlowOptions = {},
): RouteFlowSpan[] {
  if (routeGeometry.length < 2) return [];
  const corridor = opts.corridorMeters ?? DEFAULT_CORRIDOR_M;
  const tolerance = opts.directionToleranceDegrees ?? DEFAULT_DIRECTION_TOLERANCE_DEG;
  const minSpan = opts.minSpanMeters ?? DEFAULT_MIN_SPAN_M;
  const mergeGap = opts.mergeGapMeters ?? DEFAULT_MERGE_GAP_M;

  const raw: RawSpan[] = [];
  for (const segment of segments) {
    for (const span of segmentSpans(segment, routeGeometry, corridor, tolerance)) {
      if (span.endMeters - span.startMeters >= minSpan) raw.push(span);
    }
  }
  if (raw.length === 0) return [];

  // Cut the route at every span boundary, then let the worst observation own
  // each interval. This resolves overlaps without any span having to be aware
  // of its neighbours.
  const bounds = [...new Set(raw.flatMap((s) => [s.startMeters, s.endMeters]))].sort(
    (a, b) => a - b,
  );
  const intervals: RawSpan[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1];
    const end = bounds[i];
    if (end - start <= 0) continue;
    const mid = (start + end) / 2;
    let winner: RawSpan | null = null;
    for (const span of raw) {
      if (span.startMeters > mid || span.endMeters < mid) continue;
      if (!winner || span.rank > winner.rank) winner = span;
    }
    if (winner) intervals.push({ ...winner, startMeters: start, endMeters: end });
  }

  const merged: RawSpan[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      sameCondition(previous, interval) &&
      interval.startMeters - previous.endMeters <= mergeGap
    ) {
      previous.endMeters = interval.endMeters;
      continue;
    }
    merged.push({ ...interval });
  }

  return merged
    .filter((span) => span.endMeters - span.startMeters >= minSpan)
    .map(({ rank: _rank, ...span }) => span);
}
