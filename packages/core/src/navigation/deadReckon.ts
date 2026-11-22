import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import { numberAt } from "../utils/numberAt";

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
function segmentBearing(a: LngLat, b: LngLat): number {
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Cumulative great-circle distance (metres) from the route start to each
 * vertex. `result[i]` is the arc-length up to `geometry[i]`; the last entry is
 * the total route length. Precompute once per route so {@link positionAt} can
 * resolve an arc-length to a point in O(log n).
 */
export function cumulativeDistances(geometry: LngLat[]): number[] {
  const cum = [0];
  let total = 0;
  let previous = geometry[0];
  for (const vertex of geometry.slice(1)) {
    if (previous) total += haversineDistance(previous, vertex);
    cum.push(total);
    previous = vertex;
  }
  return cum;
}

/**
 * Arc-length at `index` of a {@link cumulativeDistances} result. Callers pass a
 * vertex of the same geometry; any other index reads as NaN (see {@link numberAt}).
 */
export function distanceAtVertex(cum: readonly number[], index: number): number {
  return numberAt(cum, index);
}

/**
 * Resolve an along-route distance (metres) to an interpolated position and the
 * travel bearing of the segment it falls on. `cum` must come from
 * {@link cumulativeDistances} for the same `geometry`. The distance is clamped
 * to the route, so values past the end return the final vertex.
 */
export function positionAt(
  geometry: LngLat[],
  cum: number[],
  distanceMeters: number,
): { point: LngLat; bearing: number } {
  const n = geometry.length;
  const first = geometry[0];
  if (!first) return { point: [0, 0], bearing: 0 };
  if (n === 1) return { point: first, bearing: 0 };

  const total = distanceAtVertex(cum, n - 1);
  const d = Math.min(Math.max(distanceMeters, 0), total);

  // Largest i in [0, n-2] with cum[i] <= d — the segment containing d.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (distanceAtVertex(cum, mid) <= d) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const from = geometry[i];
  const to = geometry[i + 1];
  if (!from || !to) return { point: first, bearing: 0 };
  const segLen = distanceAtVertex(cum, i + 1) - distanceAtVertex(cum, i);
  const t = segLen > 0 ? (d - distanceAtVertex(cum, i)) / segLen : 0;
  const [x1, y1] = from;
  const [x2, y2] = to;
  return {
    point: [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t],
    bearing: segmentBearing(from, to),
  };
}

export interface DeadReckonTarget {
  /** Arc-length of the most recent snapped fix, metres from the route start. */
  fixAlongMeters: number;
  /** Ground speed at that fix, m/s. Negative values are treated as 0. */
  speedMps: number;
  /** Seconds elapsed since that fix was taken. */
  ageSeconds: number;
}

export interface DeadReckonOptions {
  /** First-order filter time constant, seconds. Larger = smoother but laggier. */
  tauSeconds: number;
  /** Cap on how far ahead of a fix we dead-reckon, seconds — limits overshoot. */
  maxLeadSeconds: number;
  /** Total route length, metres; the result is clamped to [0, this]. */
  routeLengthMeters: number;
}

/**
 * Advance a displayed along-route distance toward where the traveller actually
 * is, one animation frame at a time.
 *
 * GPS fixes arrive ~1 Hz, so a position drawn straight from each fix snaps once
 * per second. Instead we carry a `displayed` arc-length that eases toward a
 * *dead-reckoned* target — the last fix's arc-length plus speed × time-since-fix
 * (capped at `maxLeadSeconds`). The target itself creeps forward between fixes,
 * so the marker glides continuously; the ease is a frame-rate-independent
 * first-order (exponential) filter, so when the traveller slows the marker
 * gently catches down to the next (shorter-than-predicted) fix rather than
 * jumping backward.
 */
/** Moving at least this fast, a small backward correction is held, not shown. */
const HOLD_MIN_SPEED_MPS = 2;
/** Behind by at most this, the projection catches up within about a second. */
const HOLD_MAX_BEHIND_M = 12;

export function stepDeadReckon(
  displayedMeters: number,
  target: DeadReckonTarget,
  dtSeconds: number,
  opts: DeadReckonOptions,
): number {
  const lead = Math.min(Math.max(target.ageSeconds, 0), opts.maxLeadSeconds);
  const projected = target.fixAlongMeters + Math.max(target.speedMps, 0) * lead;
  // While moving, a fix a few metres behind the displayed position (a late or
  // noisy fix) is caught up within a moment: hold rather than step back, or
  // the puck bounces back and forth. A stop or a large gap still corrects.
  const behind = displayedMeters - projected;
  if (target.speedMps >= HOLD_MIN_SPEED_MPS && behind > 0 && behind <= HOLD_MAX_BEHIND_M) {
    return Math.min(Math.max(displayedMeters, 0), opts.routeLengthMeters);
  }
  const tau = Math.max(opts.tauSeconds, 1e-3);
  const alpha = 1 - Math.exp(-Math.max(dtSeconds, 0) / tau);
  const next = displayedMeters + (projected - displayedMeters) * alpha;
  return Math.min(Math.max(next, 0), opts.routeLengthMeters);
}
