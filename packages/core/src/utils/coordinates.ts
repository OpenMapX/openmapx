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

/** A WGS84 position in degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * The pair as a WGS84 position when both values are finite numbers in range
 * (latitude within ±90°, longitude within ±180°), else null.
 */
export function latLngOrNull(lat: unknown, lng: unknown): LatLng | null {
  return typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
    ? { lat, lng }
    : null;
}
