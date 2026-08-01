import type { LngLat } from "../types/geometry";
import type { RoadFlowSegment, RouteFlowSpan } from "../types/roadConditions";
import { haversineDistance } from "../utils/coordinates";
import { angularDifference, bearingBetween, routeBearingAt } from "./bearing";
import { cumulativeDistances } from "./deadReckon";
import { snapToRoute } from "./snap";
import type { SnapResult } from "./types";

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

/** Metres per degree of latitude at its shortest, so a metre pad never under-pads. */
const METERS_PER_DEG_LAT = 110_574;
/**
 * Roughly how many consecutive route edges a grid cell should hold. It sets
 * how much route a corridor query drags in with the stretch it actually wants:
 * too coarse and every sample re-scans kilometres of polyline, too fine and the
 * grid costs more to walk than the edges it saves.
 */
const CELL_EDGES = 8;
/**
 * An edge spanning more cells than this is held aside rather than written into
 * every cell it crosses, which keeps one 20 km hop between two consecutive
 * route points from filling the whole grid.
 */
const MAX_CELLS_PER_EDGE = 8;
/** Past this a box query costs more than simply considering the whole route. */
const MAX_QUERY_CELLS = 4096;
/**
 * Beyond this latitude a metre-to-degree longitude pad stops being meaningful
 * (a degree of longitude is metres wide at the pole), so the query box is
 * widened to every longitude instead of being computed wrong.
 */
const POLAR_LAT_DEG = 85;

interface DegreeBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The route's edges bucketed into a coarse lon/lat grid, built once per call.
 * `snapToRoute` scans the entire polyline, so snapping every sample of every
 * flow segment against the whole route is O(routePoints) per sample — seconds
 * to minutes of uninterruptible work on the shared event loop for a long route
 * with a busy corridor. The grid answers "which edges could be within the
 * corridor of this box" in roughly constant time, so each sample only scans
 * the handful of edges that could actually win.
 */
interface RouteIndex {
  geometry: LngLat[];
  /** Along-route distance to each vertex, which makes a sub-line snap global. */
  cumulative: number[];
  cellLng: number;
  cellLat: number;
  cells: Map<string, number[]>;
  /** Edges too long to bucket; considered by every query. */
  longEdges: number[];
  edgeCount: number;
}

/** A contiguous stretch of the route that a query box touched. */
interface CorridorRun {
  /** Index of the run's first vertex in the full route. */
  start: number;
  line: LngLat[];
}

const cellKey = (col: number, row: number): string => `${col}|${row}`;

/**
 * Box around `points` guaranteed to contain everything within `padMeters` of
 * any of them, so an edge that could snap inside the corridor can never be
 * missed. Padding is computed with the shortest degree on each axis and a
 * safety factor, since it only ever costs a few extra candidate edges.
 */
function paddedBox(points: readonly LngLat[], padMeters: number): DegreeBox {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of points) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const latPad = (padMeters / METERS_PER_DEG_LAT) * 1.05;
  const maxAbsLat = Math.max(Math.abs(south), Math.abs(north));
  if (maxAbsLat > POLAR_LAT_DEG) {
    return { west: -180, south: south - latPad, east: 180, north: north + latPad };
  }
  const lngPad = latPad / Math.cos((maxAbsLat * Math.PI) / 180);
  return { west: west - lngPad, south: south - latPad, east: east + lngPad, north: north + latPad };
}

function buildRouteIndex(geometry: LngLat[], corridor: number): RouteIndex {
  const edgeCount = geometry.length - 1;
  const bounds = paddedBox(geometry, 0);
  // Each axis is sized off that axis' mean edge span, so a route that is long
  // in one direction and narrow in the other gets cells shaped the same way.
  // The floor keeps a route with near-coincident points (or no span at all on
  // one axis) from producing cells so fine that a corridor-sized box spans
  // hundreds of them.
  const minCell = (4 * corridor) / METERS_PER_DEG_LAT;
  const cellLat = Math.max(((bounds.north - bounds.south) / edgeCount) * CELL_EDGES, minCell);
  const cellLng = Math.max(((bounds.east - bounds.west) / edgeCount) * CELL_EDGES, minCell);

  const cells = new Map<string, number[]>();
  const longEdges: number[] = [];
  for (let edge = 0; edge < edgeCount; edge++) {
    const [aLng, aLat] = geometry[edge];
    const [bLng, bLat] = geometry[edge + 1];
    const colStart = Math.floor(Math.min(aLng, bLng) / cellLng);
    const colEnd = Math.floor(Math.max(aLng, bLng) / cellLng);
    const rowStart = Math.floor(Math.min(aLat, bLat) / cellLat);
    const rowEnd = Math.floor(Math.max(aLat, bLat) / cellLat);
    if ((colEnd - colStart + 1) * (rowEnd - rowStart + 1) > MAX_CELLS_PER_EDGE) {
      longEdges.push(edge);
      continue;
    }
    for (let col = colStart; col <= colEnd; col++) {
      for (let row = rowStart; row <= rowEnd; row++) {
        const key = cellKey(col, row);
        const bucket = cells.get(key);
        if (bucket) bucket.push(edge);
        else cells.set(key, [edge]);
      }
    }
  }
  return {
    geometry,
    cumulative: cumulativeDistances(geometry),
    cellLng,
    cellLat,
    cells,
    longEdges,
    edgeCount,
  };
}

/**
 * Contiguous stretches of the route whose edges the box touches, as sub-lines
 * plus the vertex they start at. A route that doubles back through the same
 * area yields one run per pass, so the two never merge into a sub-line that
 * spans the gap between them.
 */
function corridorRuns(index: RouteIndex, box: DegreeBox): CorridorRun[] {
  const colStart = Math.floor(box.west / index.cellLng);
  const colEnd = Math.floor(box.east / index.cellLng);
  const rowStart = Math.floor(box.south / index.cellLat);
  const rowEnd = Math.floor(box.north / index.cellLat);

  let edges: number[];
  if ((colEnd - colStart + 1) * (rowEnd - rowStart + 1) > MAX_QUERY_CELLS) {
    edges = Array.from({ length: index.edgeCount }, (_, i) => i);
  } else {
    const found = new Set<number>(index.longEdges);
    for (let col = colStart; col <= colEnd; col++) {
      for (let row = rowStart; row <= rowEnd; row++) {
        const bucket = index.cells.get(cellKey(col, row));
        if (bucket) for (const edge of bucket) found.add(edge);
      }
    }
    edges = [...found].sort((a, b) => a - b);
  }

  const runs: CorridorRun[] = [];
  for (let i = 0; i < edges.length; ) {
    let last = i;
    while (last + 1 < edges.length && edges[last + 1] === edges[last] + 1) last++;
    const start = edges[i];
    runs.push({ start, line: index.geometry.slice(start, edges[last] + 2) });
    i = last + 1;
  }
  return runs;
}

/**
 * Nearest point on the route to `point`, searched only within the candidate
 * runs, with `alongMeters` and `segmentIndex` translated back to the whole
 * route — the backward-jump guard and the bearing lookup both read them as
 * route-global. Any snap closer than the corridor is guaranteed to be found,
 * because the box the runs came from was padded by exactly that corridor;
 * beyond it only the fact that the sample is out of corridor matters, not how
 * far out it is.
 */
function snapWithinRuns(index: RouteIndex, runs: CorridorRun[], point: LngLat): SnapResult | null {
  let best: SnapResult | null = null;
  for (const run of runs) {
    const snap = snapToRoute(run.line, point);
    if (best && snap.deviationMeters >= best.deviationMeters) continue;
    best = {
      snapped: snap.snapped,
      alongMeters: index.cumulative[run.start] + snap.alongMeters,
      deviationMeters: snap.deviationMeters,
      segmentIndex: run.start + snap.segmentIndex,
    };
  }
  return best;
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
  index: RouteIndex,
  corridor: number,
  tolerance: number,
): RawSpan[] {
  const coords = segment.geometry.coordinates as LngLat[];
  if (coords.length < 2) return [];

  // One corridor query for the whole segment, not one per sample: the samples
  // are what gets snapped, so the box around them is the only route the segment
  // can possibly match.
  const indices = sampleIndices(coords.length);
  const sampled = indices.map((i) => coords[i]);
  const runs = corridorRuns(index, paddedBox(sampled, corridor));
  if (runs.length === 0) return [];

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

  for (const sample of indices) {
    const point = coords[sample];
    const snap = snapWithinRuns(index, runs, point);
    if (!snap || snap.deviationMeters > corridor) {
      closeRun();
      continue;
    }
    const ahead = coords[Math.min(sample + 1, coords.length - 1)];
    const behind = coords[Math.max(sample - 1, 0)];
    const segmentBearing = bearingBetween(behind, ahead);
    if (
      angularDifference(segmentBearing, routeBearingAt(index.geometry, snap.segmentIndex)) >
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

  const index = buildRouteIndex(routeGeometry, corridor);
  const raw: RawSpan[] = [];
  for (const segment of segments) {
    for (const span of segmentSpans(segment, index, corridor, tolerance)) {
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
