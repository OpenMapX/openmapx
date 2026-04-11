import type { DirectionsResult, IsochroneResult, LngLat, TravelMode } from "@openmapx/core";

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
