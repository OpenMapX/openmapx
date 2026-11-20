import type { LngLat } from "../types/geometry";
import type { IsochroneGeometry } from "../types/routing";

function pointInRing(point: LngLat, ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  let previous = ring.at(-1);
  for (const current of ring) {
    const [xi = Number.NaN, yi = Number.NaN] = current;
    const [xj = Number.NaN, yj = Number.NaN] = previous ?? current;
    previous = current;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// polygon = [outerRing, ...holes]
function pointInPolygon(point: LngLat, polygon: number[][][]): boolean {
  const [outer, ...holes] = polygon;
  if (!outer || !pointInRing(point, outer)) return false;
  for (const hole of holes) {
    if (pointInRing(point, hole)) return false; // inside a hole
  }
  return true;
}

/** True when `point` ([lng, lat]) lies inside the isochrone geometry. */
export function pointInIsochroneGeometry(point: LngLat, geometry: IsochroneGeometry): boolean {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
}
