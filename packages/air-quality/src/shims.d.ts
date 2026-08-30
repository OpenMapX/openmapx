declare module "shapefile" {
  import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
  export function read(path: string): Promise<FeatureCollection<Geometry, GeoJsonProperties>>;
}
