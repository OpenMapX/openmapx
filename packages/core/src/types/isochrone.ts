import type { LngLat } from "./geometry";

export type IsochroneTravelMode = "driving" | "walking" | "cycling";

export interface IsochronePolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface IsochroneMultiPolygon {
  type: "MultiPolygon";
  coordinates: number[][][][];
}

export type IsochroneGeometry = IsochronePolygon | IsochroneMultiPolygon;

export interface IsochroneContour {
  time: number;
  geometry: IsochroneGeometry;
}

export interface IsochroneResult {
  origin: LngLat;
  mode: IsochroneTravelMode;
  contours: IsochroneContour[];
}
