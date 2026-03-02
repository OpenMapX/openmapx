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
}

export interface DirectionsResult {
  origin: LngLat;
  destination: LngLat;
  routes: Route[];
  activeRouteIndex: number;
}
