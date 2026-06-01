import type { BBox, BoundingBox, LngLat } from "../types/geometry";

const METRES_PER_DEGREE_LAT = 111_320;

/**
 * Smallest `[west, south, east, north]` box enclosing every position in a
 * GeoJSON geometry, feature, or feature collection. Returns `null` when the
 * input carries no coordinates. Shared so the coordinate walk lives in one
 * place rather than being re-implemented per map layer.
 */
export function geoJsonBBox(input: GeoJSON.GeoJSON): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let found = false;

  const visitPositions = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const lng = coords[0] as number;
      const lat = coords[1] as number;
      found = true;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const c of coords) visitPositions(c);
  };

  const visitGeometry = (geometry: GeoJSON.Geometry): void => {
    if (geometry.type === "GeometryCollection") {
      for (const g of geometry.geometries) visitGeometry(g);
    } else {
      visitPositions(geometry.coordinates);
    }
  };

  if (input.type === "FeatureCollection") {
    for (const feature of input.features) {
      if (feature.geometry) visitGeometry(feature.geometry);
    }
  } else if (input.type === "Feature") {
    if (input.geometry) visitGeometry(input.geometry);
  } else {
    visitGeometry(input);
  }

  return found ? [west, south, east, north] : null;
}

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
