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

/**
 * How finely a bbox is quantized for cache keys, as a fraction of its own span.
 * Panning by less than this reuses the cached response; anything larger gets a
 * fresh one.
 *
 * This trades cache hit rate against how stale an edge of the map may look.
 * Worst case here is ~6% of the viewport, small enough that the served area
 * still overwhelmingly overlaps the requested one — a much finer grid would
 * make nearly every pan a miss on rate-limited upstreams for no visible gain.
 */
const BBOX_KEY_DIVISIONS = 16;

/**
 * Stable cache-key fragment for a bbox, quantized relative to its own size.
 *
 * A fixed decimal grid cannot serve both ends of the zoom range: 0.01° is finer
 * than needed for a continent and coarser than a whole city viewport, so at
 * street level it collapses genuinely different viewports onto one key and
 * serves each the answer computed for a different area. Scaling the grid to the
 * span keeps the tolerance proportional — small pans still hit the cache, while
 * a meaningfully different viewport gets its own entry at every zoom.
 */
export function bboxCacheKey(bbox: BoundingBox): string {
  const span = Math.max(bbox.north - bbox.south, bbox.east - bbox.west);
  // Snap the span to a power-of-two bucket first, so zoom jitter around a
  // threshold doesn't shift the grid itself and miss every previous entry.
  const bucket = span > 0 ? Math.floor(Math.log2(span)) : 0;
  const step = 2 ** bucket / BBOX_KEY_DIVISIONS;
  const snap = (value: number) => Math.round(value / step) * step;
  return `${snap(bbox.south)},${snap(bbox.west)},${snap(bbox.north)},${snap(bbox.east)}@${bucket}`;
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
