import type {
  DirectionsResult,
  IsochroneResult,
  LngLat,
  MatchOptions,
  MatchResult,
  MatchTracePoint,
  RoutingOptions,
  TemporalCapabilities,
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
  ScheduleDirectionsRequest,
  ScheduledDirectionsResult,
  ScheduleFidelity,
  SchedulePlanWarning,
  ScheduleViolation,
  TemporalCapabilities,
  TemporalSupport,
  TravelMode,
  TripSchedule,
  Waypoint,
  WaypointSchedule,
} from "@openmapx/core";

export interface RoutingProvider {
  readonly id: string;
  readonly supportedModes: TravelMode[];
  /**
   * Lower values are preferred when several providers support a request.
   * Each engine integration declares its own preference; the orchestrator
   * does not need to know engine IDs.
   */
  readonly priority?: number;
  /**
   * Whether `getRoute` and `optimizeRoute` honour `RoutingOptions.departAt` /
   * `arriveBy`. Providers that ignore time inputs leave this `false`/unset; the
   * orchestrator filters them out when the caller pins a wall-clock so we
   * don't silently return an untimed route to a timed request.
   */
  readonly supportsTimeAware?: boolean;
  /**
   * Whether route and optimize requests honour the generic exclusion geometry
   * in `RoutingOptions.excludeLocations` / `excludePolygons`.
   */
  readonly supportsExclusions?: boolean;
  /**
   * Per-semantic temporal support, read by the schedule planner. Providers that
   * omit it are interpreted through `supportsTimeAware` by
   * `resolveTemporalCapabilities`, so an existing provider keeps working.
   */
  readonly temporal?: TemporalCapabilities;
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
   * Optional many-to-many time/distance matrix. `rows[s][t]` gives seconds + km
   * from `sources[s]` to `targets[t]`; `null` when the engine reports the pair
   * unreachable. Used by consumers such as EV charge-planning to score detours.
   */
  getMatrix?(
    sources: LngLat[],
    targets: LngLat[],
    opts?: { mode?: TravelMode },
  ): Promise<({ seconds: number; km: number } | null)[][]>;
}

export type RoutingProviderErrorCode = "unsupported-exclusions";

/** Stable error contract for provider-side request constraints. */
export class RoutingProviderError extends Error {
  readonly status = 503;

  constructor(
    readonly code: RoutingProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoutingProviderError";
  }
}
