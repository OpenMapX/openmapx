/** [longitude, latitude] */
export type LngLat = [number, number];

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** [west, south, east, north] bounding box tuple. */
export type BBox = [west: number, south: number, east: number, north: number];

/**
 * Area outline geometry (GeoJSON Polygon or MultiPolygon, lng/lat coordinates)
 * — used for administrative boundary borders.
 */
export type AreaGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type UnitSystem = "metric" | "imperial";
