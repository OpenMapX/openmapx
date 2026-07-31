import type { LngLat } from "../types/geometry";

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Initial great-circle bearing a→b, degrees clockwise from north. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const deltaLng = toRad(b[0] - a[0]);
  const y = Math.sin(deltaLng) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0–180. */
export function angularDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/** Bearing of the route segment starting at `segmentIndex`. */
export function routeBearingAt(route: LngLat[], segmentIndex: number): number {
  const index = Math.max(0, Math.min(segmentIndex, route.length - 2));
  const start = route[index];
  const end = route[index + 1];
  return start && end ? bearingBetween(start, end) : 0;
}
