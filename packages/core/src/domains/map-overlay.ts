import type { DataSourceDetailSection } from "../types/dataSource";
import type { BoundingBox, LngLat } from "../types/geometry";

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown> | null;
  }>;
}

export interface MapOverlayData {
  type: "geojson" | "raster-tiles" | "vector-tiles";
  data?: GeoJsonFeatureCollection;
  tileUrl?: string;
  tileSize?: number;
  sourceLayer?: string;
}

export interface MapOverlayDetail {
  title: string;
  subtitle?: string;
  coordinates: LngLat;
  sections: DataSourceDetailSection[];
}

export interface MapOverlayProvider {
  readonly id: string;
  fetchData(
    bbox: BoundingBox,
    zoom: number,
    options?: Record<string, unknown>,
  ): Promise<MapOverlayData>;
  getDetail?(featureId: string): Promise<MapOverlayDetail | null>;
}
