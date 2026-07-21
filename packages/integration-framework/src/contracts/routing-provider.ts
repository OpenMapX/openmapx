import type {
  DirectionsResult,
  IsochroneResult,
  LngLat,
  MatchOptions,
  MatchResult,
  MatchTracePoint,
  RoutingOptions,
  TravelMode,
} from "@openmapx/core";

export type {
  DirectionsResult,
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
  ManeuverLane,
  ManeuverSign,
  MatchEdge,
  MatchOptions,
  MatchPoint,
  MatchResult,
  MatchShapeMatch,
  MatchTracePoint,
  Route,
  RouteLeg,
  RouteStep,
  RoutingOptions,
  TravelMode,
  Waypoint,
} from "@openmapx/core";

export interface RoutingProvider {
  readonly id: string;
  readonly supportedModes: TravelMode[];
  /**
   * Whether `getRoute` and `optimizeRoute` honour `RoutingOptions.departAt` /
   * `arriveBy`. Providers that ignore time inputs leave this `false`/unset; the
   * orchestrator filters them out when the caller pins a wall-clock so we
   * don't silently return an untimed route to a timed request.
   */
  readonly supportsTimeAware?: boolean;
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
  /**
   * Snap a recorded GPS trace to the road network and return per-edge attributes.
   * Optional — only providers backed by a real HMM map-matcher implement this.
   */
  getMatch?(
    trace: MatchTracePoint[],
    mode: TravelMode,
    options?: MatchOptions,
  ): Promise<MatchResult>;
  /**
   * Optional many-to-many time/distance matrix (Valhalla `/sources_to_targets`).
   * `rows[s][t]` gives seconds + km from `sources[s]` to `targets[t]`; `null`
   * when the engine reports the pair unreachable. Used by EV charge-planning
   * to score charger detours.
   */
  getMatrix?(
    sources: LngLat[],
    targets: LngLat[],
    opts?: { mode?: TravelMode },
  ): Promise<({ seconds: number; km: number } | null)[][]>;
}
