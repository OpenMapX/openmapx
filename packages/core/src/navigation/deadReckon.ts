import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";

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
  const cum = new Array<number>(geometry.length);
  cum[0] = 0;
  for (let i = 1; i < geometry.length; i++) {
    cum[i] = cum[i - 1] + haversineDistance(geometry[i - 1], geometry[i]);
  }
  return cum;
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
  if (n === 0) return { point: [0, 0], bearing: 0 };
  if (n === 1) return { point: geometry[0], bearing: 0 };

  const total = cum[n - 1];
  const d = Math.min(Math.max(distanceMeters, 0), total);

  // Largest i in [0, n-2] with cum[i] <= d — the segment containing d.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (d - cum[i]) / segLen : 0;
  const [x1, y1] = geometry[i];
  const [x2, y2] = geometry[i + 1];
  return {
    point: [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t],
    bearing: segmentBearing(geometry[i], geometry[i + 1]),
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
export function stepDeadReckon(
  displayedMeters: number,
  target: DeadReckonTarget,
  dtSeconds: number,
  opts: DeadReckonOptions,
): number {
  const lead = Math.min(Math.max(target.ageSeconds, 0), opts.maxLeadSeconds);
  const projected = target.fixAlongMeters + Math.max(target.speedMps, 0) * lead;
  const tau = Math.max(opts.tauSeconds, 1e-3);
  const alpha = 1 - Math.exp(-Math.max(dtSeconds, 0) / tau);
  const next = displayedMeters + (projected - displayedMeters) * alpha;
  return Math.min(Math.max(next, 0), opts.routeLengthMeters);
}
