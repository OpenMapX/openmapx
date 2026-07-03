import type { LngLat } from "./geometry";

// "transit" and "flying" are handled outside the ground-routing engines:
// transit goes through the transit plan endpoint, and "flying" is a UI-only mode
// that deep-links to external flight search (no engine routes air legs). The
// routing route handlers reject both via `parseTravelMode`'s allow-list.
export type TravelMode = "driving" | "walking" | "cycling" | "motorcycle" | "transit" | "flying";

export interface Waypoint {
  id: string;
  coords: LngLat | null;
  label: string;
  type: "origin" | "waypoint" | "destination";
}

export interface ManeuverLane {
  /** Allowed turn indications for this lane, e.g. ["straight","slight right"]. */
  indications: string[];
  /** Whether this lane is valid for the recommended maneuver. */
  valid: boolean;
  /**
   * The single recommended indication to follow within a valid lane, when the
   * engine reports it (OSRM `valid_indication`, Valhalla active/valid lane
   * direction). Lets the UI brighten the exact arrow to take in a multi-arrow
   * lane. Undefined when unknown.
   */
  active?: string;
}

/** Interchange signage for a maneuver, when the engine supplies it. */
export interface ManeuverSign {
  /** Exit numbers, e.g. ["21", "21A"]. */
  exitNumbers?: string[];
  /** Branch road refs the exit leads to, e.g. ["A 57", "B 9"]. */
  exitBranches?: string[];
  /** "Toward" destinations, e.g. ["Köln", "Bonn"]. */
  exitToward?: string[];
  /** Named exits, e.g. ["Aéroport"]. */
  exitNames?: string[];
}

export interface RouteStep {
  instruction: string;
  distance: number;
  duration: number;
  coordinates: LngLat[];
  /** Normalized maneuver for icon + voice phrasing. Optional — populated when the engine provides it. */
  maneuver?: { type: string; modifier?: string };
  /** Speed limit in km/h for this step, when known. */
  speedLimit?: number;
  /** Lane guidance at the maneuver, when known. */
  lanes?: ManeuverLane[];
  /**
   * Engine-authored spoken phrasing, when available (Valhalla `verbal_*`). These
   * are tuned for text-to-speech — they spell out road refs ("U.S. 2 22"),
   * append the next cue, and read more naturally than the on-screen
   * `instruction`. The navigation voice prefers them and falls back to
   * `instruction` when absent, so engines that don't supply them still work.
   */
  /** Advance warning, spoken well before the maneuver ("Turn right onto Main Street"). */
  verbalAlert?: string;
  /** Spoken just before the maneuver; may chain the following cue. */
  verbalPre?: string;
  /** Spoken just after the maneuver ("Continue on Main Street for 2 miles"). */
  verbalPost?: string;
  /** Brief variant for small screens / terse announcements. */
  verbalSuccinct?: string;
  /** Roundabout exit ordinal (1-based), when this is a roundabout maneuver. */
  roundaboutExitCount?: number;
  /** Interchange signage (exit number / branch / toward), when known. */
  sign?: ManeuverSign;
  /**
   * Legal driving side at this step ("left"/"right"), when the engine reports it
   * (OSRM). Lets the UI draw roundabouts in the correct rotation. Valhalla does
   * not expose it per maneuver, so it is undefined on Valhalla-served routes.
   */
  drivingSide?: "left" | "right";
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
  /**
   * Posted speed limit (km/h) per geometry segment, aligned 1:1 to `geometry`:
   * `segmentSpeedLimits[i]` is the limit on the segment from `geometry[i]` to
   * `geometry[i+1]`, so its length is `geometry.length - 1`. `null` where the
   * limit is unknown. Lets navigation read the live limit for the segment the
   * user is on (`snap.segmentIndex`) straight from the route — no per-fix
   * map-match. Populated by engines that return per-segment `maxspeed`
   * annotations (OSRM); omitted otherwise.
   */
  segmentSpeedLimits?: (number | null)[];
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
  /** Points the router must not pass through, e.g. closure centroids. */
  excludeLocations?: LngLat[];
  /** Polygon rings the router must not enter, e.g. road-closure boundaries. */
  excludePolygons?: LngLat[][];
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
  /** Posted speed limit in km/h, when known. */
  speedLimit?: number;
  /** Surface tag (paved, gravel, dirt, …). */
  surface?: string;
  /** Street names attached to the edge, when known. */
  names?: string[];
  /**
   * Whether this edge's END node is a traffic signal
   * (OSM highway=traffic_signals). The node's coordinate is
   * `MatchResult.geometry[endShapeIndex]`.
   */
  endNodeTrafficSignal?: boolean;
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
