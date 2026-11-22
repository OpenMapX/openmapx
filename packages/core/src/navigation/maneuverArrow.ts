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

const EARTH_RADIUS_M = 6371008.8;

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
  const local = line.map(toLocal);
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
      shaft.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      break;
    }
  }
  // Facing (dx, dy) with y north, the right-hand normal is (dy, −dx).
  const normalAt = (i: number): LngLat => {
    const a = shaft[Math.max(0, i - 1)] as LngLat;
    const b = shaft[Math.min(shaft.length - 1, i + 1)] as LngLat;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dy / length, -dx / length];
  };
  const side = (offset: number) =>
    shaft.map((p, i): LngLat => {
      const n = normalAt(i);
      return [p[0] + n[0] * offset, p[1] + n[1] * offset];
    });
  const half = widthMeters / 2;
  const left = side(-half);
  const right = side(half);
  const base = shaft[shaft.length - 1] as LngLat;
  const n = normalAt(shaft.length - 1);
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

  return points.map(({ p, along: a, original }, i) => {
    const offset = laneOffsetAt(a, shift);
    if (offset === 0 && original) return original;
    const before = (points[Math.max(0, i - 1)] as { p: LngLat }).p;
    const after = (points[Math.min(points.length - 1, i + 1)] as { p: LngLat }).p;
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    // Facing (dx, dy) with y north, the right-hand normal is (dy, −dx).
    return toLngLat([p[0] + (dy / length) * offset, p[1] - (dx / length) * offset]);
  });
}
