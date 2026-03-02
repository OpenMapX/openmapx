import type { LngLat } from "../types/geometry";

/** Convert degrees to radians */
const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Haversine distance between two LngLat points, in metres.
 */
export function haversineDistance(a: LngLat, b: LngLat): number {
  const R = 6_371_000; // Earth radius in metres
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const sin2 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sin2));
}

/** Round a coordinate value to 6 decimal places (~0.1 m precision). */
export function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Format a LngLat pair as a human-readable string: "48.8566, 2.3522" */
export function lngLatToString([lng, lat]: LngLat): string {
  return `${roundCoord(lat)}, ${roundCoord(lng)}`;
}
