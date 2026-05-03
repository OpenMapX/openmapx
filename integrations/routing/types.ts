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
  /**
   * Wall-clock departure time as `YYYY-MM-DDTHH:mm`. Mutually exclusive with `arriveBy`.
   * Used by Valhalla `date_time.type=1` to honour time-conditional access tags
   * (school zones, time-restricted lanes, ferries) and predicted-speed lookups.
   */
  departAt?: string;
  /**
   * Wall-clock arrival time as `YYYY-MM-DDTHH:mm`. Mutually exclusive with `departAt`.
   * Used by Valhalla `date_time.type=2`.
   */
  arriveBy?: string;
}

/** A single point in a recorded GPS trace, optionally tagged with capture time. */
export interface MatchTracePoint {
  lat: number;
  lng: number;
  /** ISO-8601 capture time (used by HMM matchers to penalise teleportation). */
  time?: string;
}

export type MatchShapeMatch = "edge_walk" | "map_snap" | "walk_or_snap";

export interface MatchOptions {
  /**
   * Matching strategy. `edge_walk` assumes the trace already follows the road
   * graph closely; `map_snap` runs a full HMM (Meili in Valhalla) for noisy
   * GPS; `walk_or_snap` (the default) tries edge_walk first then falls back.
   */
  shapeMatch?: MatchShapeMatch;
}

/** Per-edge metadata returned alongside the matched shape. */
export interface MatchEdge {
  /** OSM way id, when the underlying engine exposes it. */
  wayId?: number;
  /** Edge length in metres. */
  length: number;
  /** Posted or modelled speed in km/h. */
  speed?: number;
  /** Surface tag (paved, gravel, dirt, …). */
  surface?: string;
  /** Street names attached to the edge, when known. */
  names?: string[];
  /** Inclusive index into the matched shape where this edge begins. */
  beginShapeIndex: number;
  /** Inclusive index into the matched shape where this edge ends. */
  endShapeIndex: number;
}

/** Per-input-point matching info: where each trace point landed on the graph. */
export interface MatchPoint {
  lat: number;
  lng: number;
  /** Whether the point was matched, interpolated between matched points, or unmatched. */
  type: "matched" | "interpolated" | "unmatched";
  /** Index into `edges` of the edge this point matched to. */
  edgeIndex?: number;
  /**
   * Normalised position along the matched edge, in the range [0, 1].
   * Multiply by `edges[edgeIndex].length` (metres) for an absolute offset.
   * (Valhalla returns this as a ratio, not an absolute distance — see
   * https://valhalla.github.io/valhalla/api/map-matching/api-reference/.)
   */
  distanceAlongEdgeRatio?: number;
  /** Straight-line distance (metres) from the original trace point to the snapped position. */
  distanceFromTracePoint?: number;
}

export interface MatchResult {
  /** The snapped route geometry, point-to-road-network. */
  geometry: LngLat[];
  edges: MatchEdge[];
  points: MatchPoint[];
  mode: TravelMode;
  /** Integration ID of the provider that produced these results. */
  provider?: string;
}

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
}
