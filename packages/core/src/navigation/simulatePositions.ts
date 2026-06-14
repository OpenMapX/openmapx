import type { LngLat } from "../types/geometry";
import type { FixInput } from "./types";

interface SimulateOptions {
  /**
   * Ground distance between successive fixes, metres. Ignored when `speedMps`
   * is given (then `stepMeters = speedMps · intervalMs/1000`).
   */
  stepMeters?: number;
  /**
   * Target ground speed, m/s. When set, it drives both the fix spacing and the
   * `speed` reported on each fix — preferred for the navigation sim harness so
   * the engine (camera dead-reckoning, speed-adaptive voice) sees a realistic
   * speed rather than estimating it.
   */
  speedMps?: number;
  intervalMs?: number;
  startMs?: number;
  accuracy?: number;
  /**
   * Constant lateral offset (metres) applied perpendicular to the direction of
   * travel — to the right of it, with a fixed sign for the whole run — to
   * simulate a consistent off-route GPS bias. Applied perpendicular (not due
   * north) so it produces real cross-track deviation on a route of any heading.
   */
  offsetMeters?: number;
}

const EARTH = 6_378_137;
const toRad = (d: number) => (d * Math.PI) / 180;
/** Metres per degree of latitude (and of longitude at the equator). */
const METERS_PER_DEG = toRad(1) * EARTH;

/**
 * Displace a point `offsetMeters` to the right of `heading` (perpendicular to
 * travel). Longitude degrees are scaled by cos(lat) so the offset is the same
 * metric distance at any latitude.
 */
function applyPerpOffset(p: LngLat, heading: number, offsetMeters: number): LngLat {
  if (offsetMeters === 0) return p;
  const perp = toRad(heading + 90);
  const dLat = (offsetMeters * Math.cos(perp)) / METERS_PER_DEG;
  const dLng = (offsetMeters * Math.sin(perp)) / (METERS_PER_DEG * Math.cos(toRad(p[1])));
  return [p[0] + dLng, p[1] + dLat];
}

function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing a→b, degrees clockwise from north. */
function segmentBearing(a: LngLat, b: LngLat): number {
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Generate GPS fixes walking along a polyline at a fixed ground spacing. Each
 * fix carries a realistic `heading` (the segment bearing) and `speed` (the
 * implied ground speed, `stepMeters / interval`), so downstream consumers don't
 * have to estimate them. Pass `speedMps` to pin the speed directly.
 */
export function simulatePositions(geometry: LngLat[], options: SimulateOptions = {}): FixInput[] {
  const intervalMs = options.intervalMs ?? 1000;
  const intervalSec = intervalMs / 1000;
  // speedMps, when given, is authoritative for both spacing and the reported
  // speed; otherwise derive the speed from the requested step spacing.
  const stepMeters =
    options.speedMps != null ? options.speedMps * intervalSec : (options.stepMeters ?? 25);
  const speed = intervalSec > 0 ? stepMeters / intervalSec : 0;
  const startMs = options.startMs ?? 0;
  const accuracy = options.accuracy ?? 5;
  const offsetMeters = options.offsetMeters ?? 0;

  const fixes: FixInput[] = [];
  let t = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const segLen = haversine(a, b);
    if (segLen === 0) continue;
    const heading = segmentBearing(a, b);
    for (let d = 0; d < segLen; d += stepMeters) {
      const p = lerp(a, b, d / segLen);
      fixes.push({
        coords: applyPerpOffset(p, heading, offsetMeters),
        accuracy,
        timestampMs: startMs + t * intervalMs,
        heading,
        speed,
      });
      t++;
    }
  }
  const last = geometry[geometry.length - 1];
  const prev = geometry[geometry.length - 2] ?? last;
  const lastHeading = segmentBearing(prev, last);
  fixes.push({
    coords: applyPerpOffset(last, lastHeading, offsetMeters),
    accuracy,
    timestampMs: startMs + t * intervalMs,
    heading: lastHeading,
    speed,
  });
  return fixes;
}
