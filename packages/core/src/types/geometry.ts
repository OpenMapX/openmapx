export type { BBox, BoundingBox, LngLat } from "@openmapx/mobility-core/geometry";

/**
 * Area outline geometry (GeoJSON Polygon or MultiPolygon, lng/lat coordinates)
 * — used for administrative boundary borders.
 */
export type AreaGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type UnitSystem = "metric" | "imperial";
