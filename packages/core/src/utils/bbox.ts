import type { BoundingBox, LngLat } from "../types/geometry";

const METRES_PER_DEGREE_LAT = 111_320;

export function bboxAroundPoint(center: LngLat, radiusMetres: number): BoundingBox {
  const [lng, lat] = center;
  const latDelta = radiusMetres / METRES_PER_DEGREE_LAT;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusMetres / (METRES_PER_DEGREE_LAT * Math.max(cosLat, 1e-6));
  return {
    west: lng - lngDelta,
    south: lat - latDelta,
    east: lng + lngDelta,
    north: lat + latDelta,
  };
}
