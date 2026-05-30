import type { LngLat } from "../types/geometry";

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Great-circle (orthodrome) interpolation between two `[lng, lat]` points,
 * returning `steps + 1` points along the shortest path — the curved flight
 * line shown on the map.
 *
 * Longitudes are "unwrapped" (allowed to run past ±180) so a path crossing the
 * antimeridian renders as one continuous line instead of snapping back across
 * the whole map. MapLibre normalises out-of-range longitudes when drawing.
 */
export function greatCircleArc(a: LngLat, b: LngLat, steps = 64): LngLat[] {
  const lon1 = toRad(a[0]);
  const lat1 = toRad(a[1]);
  const lon2 = toRad(b[0]);
  const lat2 = toRad(b[1]);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (d === 0) return [a, b];

  const points: LngLat[] = [];
  let prevLng: number | null = null;
  let offset = 0;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lng = toDeg(Math.atan2(y, x));
    if (prevLng !== null) {
      if (lng - prevLng > 180) offset -= 360;
      else if (lng - prevLng < -180) offset += 360;
    }
    prevLng = lng;
    points.push([lng + offset, toDeg(lat)]);
  }
  return points;
}

/** Typical jet cruise speed (km/h) used for the rough flight-time estimate. */
const CRUISE_KMH = 800;
/** Fixed minutes added for taxi, climb, descent and schedule padding. */
const GROUND_BUFFER_MIN = 45;

/**
 * Rough in-air flight-time estimate (minutes) from great-circle distance in km.
 * Deliberately approximate — actual times depend on routing, winds and stops.
 */
export function estimateFlightMinutes(distanceKm: number): number {
  return Math.round((distanceKm / CRUISE_KMH) * 60 + GROUND_BUFFER_MIN);
}
