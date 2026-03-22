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
  origin: [number, number];
  mode: IsochroneTravelMode;
  contours: IsochroneContour[];
}

export interface IsochroneProvider {
  isochrone(
    origin: [number, number],
    mode: IsochroneTravelMode,
    contourMinutes: number[],
  ): Promise<IsochroneResult>;
}
