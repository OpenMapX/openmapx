import type { LngLat } from "./geometry";

export type TravelMode = "driving" | "walking" | "cycling" | "transit";

export interface RouteStep {
  instruction: string;
  distance: number;
  duration: number;
  coordinates: LngLat[];
}

export interface Route {
  distance: number;
  duration: number;
  geometry: LngLat[];
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
  origin: LngLat;
  destination: LngLat;
  routes: Route[];
  activeRouteIndex: number;
}
