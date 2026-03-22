import type { LngLat } from "./geometry";

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
}
