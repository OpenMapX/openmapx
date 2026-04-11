import type { LngLat } from "@openmapx/core";

export type TravelMode = "driving" | "walking" | "cycling" | "transit";

export interface Waypoint {
  id: string;
  coords: LngLat | null;
  label: string;
  type: "origin" | "waypoint" | "destination";
}

export interface RouteStep {
  instruction: string;
  distance: number;
  duration: number;
  coordinates: LngLat[];
}

export interface RouteLeg {
  distance: number;
  duration: number;
  geometry: LngLat[];
  steps: RouteStep[];
  summary?: string;
}

export interface Route {
  distance: number;
  duration: number;
  geometry: LngLat[];
  legs: RouteLeg[];
  steps: RouteStep[];
  mode: TravelMode;
  /** Human-readable summary of the primary road, e.g. "via A57" */
  summary?: string;
  /** Elevation values (metres) at regular intervals along the route */
  elevation?: number[];
  /** Distance in metres between elevation samples */
  elevationInterval?: number;
}

export interface DirectionsResult {
  waypoints: LngLat[];
  routes: Route[];
  activeRouteIndex: number;
  optimizedOrder?: number[];
  /** Integration ID of the routing provider that produced these results. */
  provider?: string;
}

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

export interface RoutingOptions {
  alternatives?: boolean;
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
}

export interface RoutingProvider {
  readonly id: string;
  readonly supportedModes: TravelMode[];
  getRoute(
    waypoints: LngLat[],
    mode: TravelMode,
    options?: RoutingOptions,
  ): Promise<DirectionsResult>;
  getIsochrone?(origin: LngLat, mode: TravelMode, minutes: number[]): Promise<IsochroneResult>;
  optimizeRoute?(
    waypoints: LngLat[],
    mode: TravelMode,
    options?: RoutingOptions,
  ): Promise<DirectionsResult>;
}
