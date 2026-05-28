import type { IsochroneGeometry } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";

function pointInRing(point: LngLat, ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// polygon = [outerRing, ...holes]
function pointInPolygon(point: LngLat, polygon: number[][][]): boolean {
  if (polygon.length === 0 || !pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(point, polygon[i])) return false; // inside a hole
  }
  return true;
}

/** True when `point` ([lng, lat]) lies inside the isochrone geometry. */
export function pointInIsochroneGeometry(point: LngLat, geometry: IsochroneGeometry): boolean {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}
