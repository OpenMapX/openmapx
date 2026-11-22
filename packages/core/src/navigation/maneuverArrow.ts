import type { LngLat } from "../types/geometry";
import type { TravelMode } from "../types/routing";
import { bearingBetween } from "./bearing";
import { distanceAtVertex, positionAt } from "./deadReckon";
import { LANE_ENTRY_M, type LanePath, laneOffsetAt } from "./lanePath";

/** How much route the arrow shows before / after the maneuver point. */
export interface ManeuverArrowSpans {
  before: number;
  after: number;
}

const MODE_SPANS: Record<string, ManeuverArrowSpans> = {
  driving: { before: 60, after: 40 },
  motorcycle: { before: 60, after: 40 },
  walking: { before: 30, after: 20 },
  cycling: { before: 30, after: 20 },
};

/** A route must be at least this long for an arrow to make sense on it. */
const MIN_ROUTE_METERS = 10;

/** Spans for the ground travel mode: motorised modes show more road. */
export function maneuverArrowSpans(mode: TravelMode): ManeuverArrowSpans {
  return MODE_SPANS[mode] ?? { before: 30, after: 20 };
}

/**
 * The polyline between two along-route distances: interpolated endpoints plus
 * every route vertex strictly between them.
 */
function sliceBetween(
  geometry: LngLat[],
  cum: number[],
  fromMeters: number,
  toMeters: number,
): LngLat[] {
  const start = positionAt(geometry, cum, fromMeters).point;
  const points: LngLat[] = [start];
  for (const [i, vertex] of geometry.entries()) {
    if (i === 0) continue;
    if (i === geometry.length - 1) break;
    const along = distanceAtVertex(cum, i);
    if (along <= fromMeters) continue;
    if (along >= toMeters) break;
    points.push(vertex);
  }
  const end = positionAt(geometry, cum, toMeters).point;
  const last = points.at(-1) ?? start;
  if (last[0] !== end[0] || last[1] !== end[1]) points.push(end);
  return points;
}

/**
 * The route-following arrow through a maneuver point: the vertices between
 * `spans.before` metres upstream and `spans.after` metres downstream, clamped
 * to the route ends. `null` when the route is too short to carry an arrow.
 */
export function maneuverArrowLine(
  geometry: LngLat[],
  cum: number[],
  alongMeters: number,
  spans: ManeuverArrowSpans,
): LngLat[] | null {
  const total = distanceAtVertex(cum, cum.length - 1);
  if (total < MIN_ROUTE_METERS) return null;
  const from = Math.max(alongMeters - spans.before, 0);
  const to = Math.min(alongMeters + spans.after, total);
  const line = sliceBetween(geometry, cum, from, to);
  return line.length >= 2 ? line : null;
}

/** Bearing (degrees from north) of the arrow's last segment — the arrowhead's rotation. */
export function maneuverArrowTipBearing(line: LngLat[]): number {
  const from = line.at(-2);
  const to = line.at(-1);
  // An arrow line always has two points; without them there is no direction to point in.
  if (!from || !to) return 0;
  return bearingBetween(from, to);
}

/** How far either way `smoothArrowLine` averages: enough to iron out a lane-wide step. */
const SMOOTH_RADIUS_M = 8;
const SMOOTH_STEP_M = 1;

/**
 * The arrow line with its sub-lane wiggles ironed out. Routes step sideways
 * where a road splits into two carriageways or gains a turn lane, often just
 * before the junction, and the wide arrow shows each step as a zig-zag. The
 * line is resampled every metre and each point averaged with its neighbours
 * up to `radiusMeters` either way, fewer towards the ends, so both ends and
 * the head's direction stay put. Corners round off by a metre or two, the way
 * a car drives them.
 */
export function smoothArrowLine(line: LngLat[], radiusMeters = SMOOTH_RADIUS_M): LngLat[] {
  const first = line[0];
  const last = line.at(-1);
  if (!first || !last || line.length < 3) return line;
  const cos = Math.cos((first[1] * Math.PI) / 180);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const local = line.map(([lng, lat]): XY => [(lng - first[0]) * k * cos, (lat - first[1]) * k]);

  // Resample every SMOOTH_STEP_M, keeping the far end.
  const samples: XY[] = [local[0] as XY];
  const along: number[] = [0];
  let walked = 0;
  let next = SMOOTH_STEP_M;
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1] as XY;
    const b = local[i] as XY;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (next < walked + length) {
      const t = (next - walked) / length;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along.push(next);
      next += SMOOTH_STEP_M;
    }
    walked += length;
  }
  if (walked < 2 * SMOOTH_STEP_M) return line;
  if (walked - (along.at(-1) as number) < SMOOTH_STEP_M / 2) {
    samples.pop();
    along.pop();
  }
  samples.push(local.at(-1) as XY);
  along.push(walked);

  const smoothed = samples.map((point, i): LngLat => {
    const at = along[i] as number;
    const reach = Math.min(radiusMeters, at, walked - at);
    if (reach < SMOOTH_STEP_M) return [first[0] + point[0] / (k * cos), first[1] + point[1] / k];
    let x = 0;
    let y = 0;
    let weights = 0;
    for (let j = 0; j < samples.length; j++) {
      const d = Math.abs((along[j] as number) - at);
      if (d > reach) continue;
      const w = 1 - d / (reach + SMOOTH_STEP_M);
      const p = samples[j] as XY;
      x += p[0] * w;
      y += p[1] * w;
      weights += w;
    }
    return [first[0] + x / weights / (k * cos), first[1] + y / weights / k];
  });
  smoothed[0] = first;
  smoothed[smoothed.length - 1] = last;
  return smoothed;
}

const EARTH_RADIUS_M = 6371008.8;

type XY = [number, number];

/** A sharp corner's mitre reaches at most this many offsets out, then is cut short. */
const MITER_LIMIT = 2;

/** Unit right-hand normal of the travel direction from `a` to `b`; undefined for a point. */
function rightNormal(a: XY, b: XY): XY | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  // Facing (dx, dy) with y north, the right-hand normal is (dy, −dx).
  return length > 1e-9 ? [dy / length, -dx / length] : undefined;
}

/**
 * Each point moved `offsetAt(i)` metres to the right of travel (negative:
 * left). A corner is mitred, so both segments meeting there keep the offset;
 * moving it along the averaged normal instead notches an inner corner, and the
 * notch folds the outline over itself.
 */
function offsetPoints(points: readonly XY[], offsetAt: (i: number) => number): XY[] {
  return points.map((p, i) => {
    const offset = offsetAt(i);
    if (offset === 0) return p;
    const before = i > 0 ? rightNormal(points[i - 1] as XY, p) : undefined;
    const after = i < points.length - 1 ? rightNormal(p, points[i + 1] as XY) : undefined;
    const a = before ?? after;
    const b = after ?? before;
    if (!a || !b) return p;
    const cos = a[0] * b[0] + a[1] * b[1];
    // The mitre m meets both offset segments: a·m = b·m = 1.
    let m: XY = cos > -1 + 1e-9 ? [(a[0] + b[0]) / (1 + cos), (a[1] + b[1]) / (1 + cos)] : a;
    const reach = Math.hypot(m[0], m[1]);
    if (reach > MITER_LIMIT) m = [(m[0] / reach) * MITER_LIMIT, (m[1] / reach) * MITER_LIMIT];
    return [p[0] + m[0] * offset, p[1] + m[1] * offset];
  });
}

/**
 * The moved points without those that step backwards against the source's
 * travel direction. Inside a corner tighter than the offset, a mitre lands
 * behind the point before it and the line doubles back on itself. The first
 * and last points always stay.
 */
function withoutReversals<T extends { p: XY }>(source: readonly XY[], moved: readonly T[]): T[] {
  const kept: T[] = [];
  let keptIndex = 0;
  moved.forEach((point, i) => {
    const previous = kept.at(-1);
    if (!previous || i === moved.length - 1) {
      kept.push(point);
      keptIndex = i;
      return;
    }
    const s0 = source[keptIndex] as XY;
    const s1 = source[i] as XY;
    const forward =
      (point.p[0] - previous.p[0]) * (s1[0] - s0[0]) +
      (point.p[1] - previous.p[1]) * (s1[1] - s0[1]);
    if (forward > 0) {
      kept.push(point);
      keptIndex = i;
    }
  });
  return kept;
}

/** Where segments ab and cd cross, or undefined when they do not. */
function crossing(a: XY, b: XY, c: XY, d: XY): XY | undefined {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [a[0] + rx * t, a[1] + ry * t] : undefined;
}

/**
 * The line with every loop shorter than `maxLoopMeters` cut out at the point
 * where it crosses itself. An offset line loops on the inside of a corner
 * tighter than its offset; MapLibre then fills the crossed outline across the
 * whole arrow. A longer loop is the road's own (a ramp), and stays.
 */
function cutShortLoops<T extends { p: XY }>(
  points: readonly T[],
  maxLoopMeters: number,
  at: (p: XY) => T,
): T[] {
  const out = [...points];
  for (let i = 0; i < out.length - 3; i++) {
    let loop = 0;
    let longest = i + 2;
    for (let j = i + 1; j < out.length - 1 && loop <= maxLoopMeters; j++) {
      loop += Math.hypot(
        (out[j] as T).p[0] - (out[j - 1] as T).p[0],
        (out[j] as T).p[1] - (out[j - 1] as T).p[1],
      );
      if (loop <= maxLoopMeters) longest = j + 1;
    }
    for (let j = Math.min(longest, out.length - 2); j > i + 1; j--) {
      const x = crossing(
        (out[i] as T).p,
        (out[i + 1] as T).p,
        (out[j] as T).p,
        (out[j + 1] as T).p,
      );
      if (x) {
        out.splice(i + 1, j - i, at(x));
        break;
      }
    }
  }
  return out;
}

/** The points without any closer than `gap` metres to the one kept before it; the last always stays. */
function withoutCrowding(points: readonly XY[], gap: number): XY[] {
  const last = points.at(-1);
  if (!last) return [];
  const kept: XY[] = [];
  for (const p of points.slice(0, -1)) {
    const previous = kept.at(-1);
    if (!previous || Math.hypot(p[0] - previous[0], p[1] - previous[1]) >= gap) kept.push(p);
  }
  while (kept.length > 1) {
    const previous = kept.at(-1) as XY;
    if (Math.hypot(last[0] - previous[0], last[1] - previous[1]) >= gap) break;
    kept.pop();
  }
  kept.push(last);
  return kept;
}

/**
 * The arrow line as one closed outline on the ground, for the raised 3D arrow
 * (immersive navigation spec §9.3): a shaft `widthMeters` wide and, at the
 * tip, a head twice as wide and `headMeters` long. Empty when the line is too
 * short to carry a head.
 */
export function raisedArrowPolygon(line: LngLat[], widthMeters = 2.4, headMeters = 5): LngLat[] {
  const tip = line.at(-1);
  if (!tip || line.length < 2) return [];
  const cos = Math.cos((tip[1] * Math.PI) / 180);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const toLocal = ([lng, lat]: LngLat): LngLat => [(lng - tip[0]) * k * cos, (lat - tip[1]) * k];
  const toLngLat = ([x, y]: LngLat): LngLat => [tip[0] + x / (k * cos), tip[1] + y / k];
  // Points a hair apart give a segment whose direction is noise.
  const gap = widthMeters / 4;
  const local = withoutCrowding(line.map(toLocal), gap);
  const cum = [0];
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1] as LngLat;
    const b = local[i] as LngLat;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1] as number;
  if (total <= headMeters + 0.5) return [];

  // The shaft runs up to the base of the head.
  const baseAlong = total - headMeters;
  const shaft: LngLat[] = [];
  for (let i = 0; i < local.length; i++) {
    if ((cum[i] as number) < baseAlong) shaft.push(local[i] as LngLat);
    else {
      const a = local[i - 1] as LngLat;
      const b = local[i] as LngLat;
      const span = (cum[i] as number) - (cum[i - 1] as number);
      const t = span > 0 ? (baseAlong - (cum[i - 1] as number)) / span : 0;
      const base: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const previous = shaft.at(-1);
      if (
        shaft.length > 1 &&
        previous &&
        Math.hypot(base[0] - previous[0], base[1] - previous[1]) < gap
      ) {
        shaft.pop();
      }
      shaft.push(base);
      break;
    }
  }
  const base = shaft[shaft.length - 1] as LngLat;
  // The head points from its base to the tip, and the shaft's end is mitred
  // against that direction, so the shaft meets the head square.
  const n = rightNormal(base, [0, 0]) ?? [0, 0];
  const half = widthMeters / 2;
  const withTip = [...shaft, [0, 0] as XY];
  const side = (offset: number) =>
    cutShortLoops(
      withoutReversals(
        shaft,
        offsetPoints(withTip, () => offset)
          .slice(0, -1)
          .map((p) => ({ p })),
      ),
      2 * widthMeters,
      (p) => ({ p }),
    ).map(({ p }) => p);
  const left = side(-half);
  const right = side(half);
  const headLeft: LngLat = [base[0] - n[0] * widthMeters, base[1] - n[1] * widthMeters];
  const headRight: LngLat = [base[0] + n[0] * widthMeters, base[1] + n[1] * widthMeters];
  const ring = [...left, headLeft, [0, 0] as LngLat, headRight, ...right.reverse()];
  ring.push(ring[0] as LngLat);
  return ring.map(toLngLat);
}

/** The raised and flat arrow heads are this long. */
export const ARROW_HEAD_M = 5;

/**
 * Where the car and the arrow are back on the route line after a lane-guided
 * turn: at the base of the arrow head, so the head points along the route.
 */
export function laneRejoinAlong(maneuverAlong: number, mode: TravelMode): number {
  return maneuverAlong + Math.max(0, maneuverArrowSpans(mode).after - ARROW_HEAD_M);
}

/** A taper mark this close to an existing vertex reuses it. */
const MARK_EPSILON_M = 0.01;

/**
 * The arrow line moved sideways along the lane path (see `laneOffsetAt`), so
 * the arrow runs where the car is drawn and points into the same lane as the
 * lane highlight. `lineStartAlong` is the along-route distance of `line[0]`.
 */
export function laneShiftedArrowLine(
  line: LngLat[],
  lineStartAlong: number,
  shift: LanePath,
): LngLat[] {
  const tip = line.at(-1);
  if (!tip || line.length < 2 || shift.offsetMeters === 0) return line;
  const cos = Math.cos((tip[1] * Math.PI) / 180);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const toLocal = ([lng, lat]: LngLat): LngLat => [(lng - tip[0]) * k * cos, (lat - tip[1]) * k];
  const toLngLat = ([x, y]: LngLat): LngLat => [tip[0] + x / (k * cos), tip[1] + y / k];

  // Vertices with their along-route distance, plus vertices where the offset
  // starts or stops changing, so it bends exactly there.
  const marks = [
    shift.fromAlong,
    shift.fromAlong + Math.min(LANE_ENTRY_M, Math.max(shift.toAlong - shift.fromAlong, 0)),
    shift.toAlong,
    shift.rejoinAlong,
  ];
  const points: { p: LngLat; along: number; original?: LngLat }[] = [];
  let along = lineStartAlong;
  line.forEach((vertex, i) => {
    const p = toLocal(vertex);
    if (i > 0) {
      const prev = points[points.length - 1] as { p: LngLat; along: number };
      const length = Math.hypot(p[0] - prev.p[0], p[1] - prev.p[1]);
      const next = along + length;
      for (const mark of marks) {
        if (mark > along + MARK_EPSILON_M && mark < next - MARK_EPSILON_M) {
          const t = (mark - along) / length;
          points.push({
            p: [prev.p[0] + (p[0] - prev.p[0]) * t, prev.p[1] + (p[1] - prev.p[1]) * t],
            along: mark,
          });
        }
      }
      along = next;
    }
    points.push({ p, along, original: vertex });
  });
  points.sort((a, b) => a.along - b.along);

  const offsets = points.map(({ along: a }) => laneOffsetAt(a, shift));
  const source = points.map(({ p }) => p);
  const moved = offsetPoints(source, (i) => offsets[i] ?? 0).map((p, i) => {
    const { original } = points[i] as { original?: LngLat };
    return { p, original: offsets[i] === 0 ? original : undefined };
  });
  return cutShortLoops(withoutReversals(source, moved), 4 * Math.abs(shift.offsetMeters), (p) => ({
    p,
    original: undefined,
  })).map(({ p, original }) => original ?? toLngLat(p));
}
