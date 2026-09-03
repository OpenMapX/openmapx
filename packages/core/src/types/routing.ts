import type { DataSourceAttribution } from "./dataSource";
import type { ConnectorStandard, EvVehicleSpec } from "./ev";
import type { LngLat } from "./geometry";

// "transit", "flying" and "ride" are handled outside the ground-routing engines:
// transit goes through the transit plan endpoint, "flying" deep-links to
// external flight search, and "ride" pairs a driving route with a ride-hailing
// provider handoff. No engine routes any of them, and the routing route
// handlers reject all three via `parseTravelMode`'s allow-list.
export type TravelMode =
  | "driving"
  | "walking"
  | "cycling"
  | "motorcycle"
  | "transit"
  | "flying"
  | "ride";

/**
 * Temporal constraints at one waypoint. Every wall clock is `YYYY-MM-DDTHH:mm`
 * local to `timeZone`; when `timeZone` is omitted it is resolved from the
 * waypoint's coordinate.
 */
export interface WaypointSchedule {
  /** Earliest permitted departure from this waypoint. */
  departAfter?: string;
  /** Latest permitted arrival at this waypoint. */
  arriveBy?: string;
  /**
   * Appointment time: be here at this moment. Dwell then runs from the
   * appointment rather than from arrival, so arriving early still departs at
   * `fixedAt + dwellSeconds`. Cannot be combined with the two fields above.
   */
  fixedAt?: string;
  /** Time spent at this waypoint before departing, in seconds. */
  dwellSeconds?: number;
  /** IANA zone the wall clocks above are expressed in, e.g. "Europe/Berlin". */
  timeZone?: string;
}

export interface Waypoint {
  id: string;
  coords: LngLat | null;
  label: string;
  type: "origin" | "waypoint" | "destination";
  /** Temporal constraints for this stop. Absent means "no constraint". */
  schedule?: WaypointSchedule;
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
  /** Road names and refs for this step, used to match direction-specific incidents to the route. */
  roadNames?: string[];
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
  /**
   * Trip duration in seconds with live traffic excluded — the same path recosted
   * against freeflow/constrained/predicted speeds only. Present only when the
   * engine returned a recosting for a motorised route; `undefined` otherwise.
   * Compare against `duration` (which does include live traffic) to get the
   * delay attributable to current conditions.
   */
  baselineDuration?: number;
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
  /**
   * Provider-reported transit CO2 per passenger for the whole route (grams).
   * Set by transit engines that return their own emissions estimate; when
   * present the impact engine prefers it over the regional average.
   */
  co2Grams?: number;
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
  /** Runtime-resolved credits for the backend that answered this request. */
  attributions?: import("@openmapx/mobility-core/attribution").Attribution[];
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
   * Providers that support time-aware routing map this generic value to their
   * engine-specific time model.
   */
  departAt?: string;
  /**
   * Wall-clock arrival time as `YYYY-MM-DDTHH:mm`. Mutually exclusive with `departAt`.
   * Providers that support time-aware routing map this generic value to their
   * engine-specific time model.
   */
  arriveBy?: string;
  /** Points the router must not pass through, e.g. closure centroids. */
  excludeLocations?: LngLat[];
  /** Polygon rings the router must not enter, e.g. road-closure boundaries. */
  excludePolygons?: LngLat[][];
  /**
   * Request live speed observations, when the selected provider supports them,
   * in addition to its normal historical/predicted speed model. Callers should
   * default this on for motorised modes and off for bike/pedestrian; the policy
   * lives at the route-handler layer, not here.
   */
  useLiveTraffic?: boolean;
  /**
   * Seconds to spend at each waypoint before departing, aligned index-for-index
   * with the waypoint list. Engines that model per-location service time advance
   * their own clock by it, so later legs are costed for the later hour. Ignored
   * at the origin and destination.
   */
  dwellSeconds?: (number | undefined)[];
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

/** Request body for `POST /directions/ev` — a route with EV charge stops inserted. */
export interface EvDirectionsRequest {
  /** Origin…destination, in order. At least 2 required. */
  waypoints: LngLat[];
  /** Vehicle preset key. One of `vehicleId` or `vehicle` is required. */
  vehicleId?: string;
  /** Inline vehicle spec, overriding `vehicleId`. */
  vehicle?: EvVehicleSpec;
  /** Current battery state of charge, 0–100. */
  socStartPct: number;
  /** Minimum SoC to keep in reserve on arrival, 0–100. Default 10. */
  socArrivalMinPct?: number;
  /** User's charge-to preference at each stop, 0–100. Default 80 (distinct from the vehicle's chemistry taper). */
  socTargetPct?: number;
  /** Ambient temperature (°C), affects consumption. Default 20. */
  ambientTempC?: number;
  /** Wall-clock departure time `YYYY-MM-DDTHH:mm`. */
  departAt?: string;
  /** Inject active road closures as routing exclusions. */
  avoidClosures?: boolean;
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  avoidFerries?: boolean;
  /** Operator display names to favour (subscription/RFID access). */
  preferredNetworks?: string[];
  /** Operator display names to de-prioritise. */
  avoidedNetworks?: string[];
  /** Treat `preferredNetworks` as a hard whitelist instead of a soft preference. */
  exclusiveNetworks?: boolean;
  /** Bias stop selection toward cheaper session cost. Default true. */
  preferCheaper?: boolean;
  /** User's home electricity tariff, used to estimate whole-trip cost. */
  homePricePerKwh?: number;
  /** Currency of `homePricePerKwh`, e.g. "EUR". */
  homeCurrency?: string;
  units?: "metric" | "imperial";
  lang?: string;
}

/** A charging stop inserted into an EV route plan. */
export interface EvChargeStop {
  /** Subset of the charging station identity/location needed to render the stop — not the full provider record. */
  station: { id: string; name: string; coordinates: LngLat };
  connector: ConnectorStandard;
  powerKw: number;
  /** Network/operator display name, for badge + display. */
  operator?: string;
  /** True when `operator` matches one of the request's `preferredNetworks`. */
  isPreferredNetwork?: boolean;
  arriveSocPct: number;
  departSocPct: number;
  chargeSeconds: number;
  addedKwh: number;
  /**
   * Live availability at plan time, when the source reports it. Structural
   * shape matching mobility-core's `EvseAvailability` field-for-field — kept
   * inline here so `@openmapx/core` never imports `@openmapx/mobility-core`.
   */
  availability?: { available: number; total: number; updatedAt: string };
  tariffSummary?: string;
  /** Modelled cost of this charging session. */
  estimatedCost?: { amount: number; currency: string };
  attributions: DataSourceAttribution[];
}

/**
 * Why a plan fell short of a complete route. `tight-margin` is emitted by the
 * post-reroute whole-trip re-validation pass, when the final route arrives
 * within a thin band of the reserve.
 */
export type EvPlanWarning =
  | { kind: "unreachable"; afterStopIndex: number }
  | { kind: "tight-margin"; legIndex: number }
  | { kind: "no-charger-data" }
  | { kind: "no-allowed-network"; afterStopIndex: number };

/**
 * Response for `POST /directions/ev`. EV mode always returns a single
 * primary route (no alternates — inserted stops make the request
 * multi-waypoint, and Valhalla only produces alternates for exactly 2), so
 * `routes` has length 1 and `activeRouteIndex` is 0.
 */
export interface EvDirectionsResult extends DirectionsResult {
  /** Charge stops, aligned to `routes[activeRouteIndex]`'s inserted legs. */
  stops: EvChargeStop[];
  totals: {
    driveSeconds: number;
    chargeSeconds: number;
    energyKwh: number;
    /** Present when a home price was given. */
    estimatedCost?: {
      amount: number;
      currency: string;
      homeKwh: number;
      publicKwh: number;
      /** Public sessions priced in a currency other than `currency`, summed per currency (no FX conversion). */
      otherCurrencies?: { currency: string; amount: number }[];
    };
  };
  warnings: EvPlanWarning[];
}

/** How faithfully a provider can honour one temporal semantic. */
export type TemporalSupport =
  /** The engine itself enforces the semantic. */
  | "native"
  /** OpenMapX enforces it exactly, by orchestrating several engine calls. */
  | "emulated"
  /** Enforced arithmetically, on travel times that ignore the departure instant. */
  | "approximate"
  /** Cannot be honoured; a request needing it is rejected. */
  | "unsupported";

/**
 * Response-level summary of the semantics one request actually used. `"exact"`
 * covers `native` and `emulated`; `"approximate"` means the wall clocks rest on
 * travel times that do not vary with the departure instant.
 */
export type ScheduleFidelity = "exact" | "approximate";

/** Per-semantic temporal support declared by a routing or transit provider. */
export interface TemporalCapabilities {
  /** Trip-level departure pin. */
  tripDepartAt: TemporalSupport;
  /** Trip-level arrival pin. */
  tripArriveBy: TemporalSupport;
  /** Dwell at an intermediate waypoint. */
  dwell: TemporalSupport;
  /** Earliest-departure window at a waypoint. */
  waypointDepartAfter: TemporalSupport;
  /** Latest-arrival window at a waypoint. */
  waypointArriveBy: TemporalSupport;
  /** Travel time varies with the departure instant. */
  timeDependentTravel: TemporalSupport;
}

/**
 * Why a set of constraints cannot be satisfied. Every variant names the
 * waypoint, and the time-bearing ones carry rendered wall clocks so a caller
 * can show the interval without re-deriving zones.
 */
export type ScheduleViolation =
  | { kind: "conflicting-fields"; waypointIndex: number; fields: string[] }
  | { kind: "invalid-time"; waypointIndex: number; field: string; value: string }
  | { kind: "invalid-dwell"; waypointIndex: number; dwellSeconds: number }
  | {
      kind: "inverted-order";
      fromIndex: number;
      toIndex: number;
      earliestDeparture: string;
      latestArrival: string;
    }
  | { kind: "anchor-conflict"; waypointIndex: number; anchor: string; latestArrival: string }
  | {
      kind: "late-arrival";
      waypointIndex: number;
      requiredBy: string;
      earliestArrival: string;
      shortfallSeconds: number;
    }
  | {
      kind: "early-departure";
      waypointIndex: number;
      allowedFrom: string;
      latestDeparture: string;
      shortfallSeconds: number;
    }
  | { kind: "unreachable"; fromIndex: number; toIndex: number };

/** One stop on a resolved trip schedule. */
export interface ScheduledStop {
  waypointIndex: number;
  timeZone: string;
  /** ISO-8601 with this stop's own offset; absent at the origin. */
  arrival?: string;
  /** ISO-8601 with this stop's own offset; absent at the destination. */
  departure?: string;
  dwellSeconds: number;
  /** Idle seconds beyond dwell, caused by a binding window. */
  waitSeconds: number;
  utcOffsetMinutes: number;
}

/** One travelled leg on a resolved trip schedule. */
export interface ScheduledLeg {
  fromIndex: number;
  toIndex: number;
  departure: string;
  arrival: string;
  travelSeconds: number;
}

/** The canonical timeline for a trip: when you are where, and why you wait. */
export interface TripSchedule {
  stops: ScheduledStop[];
  legs: ScheduledLeg[];
  departure: string;
  arrival: string;
  totalTravelSeconds: number;
  totalDwellSeconds: number;
  totalWaitSeconds: number;
  /** The trip's ends fall on different local calendar days. */
  multiDay: boolean;
  violations: ScheduleViolation[];
}

/** Why a scheduled plan is less than the caller asked for, without being wrong. */
export type SchedulePlanWarning =
  /** Travel times come from an engine that ignores the departure instant. */
  | { kind: "approximate-travel-times"; providerId: string }
  /** One leg fell through from one provider to another mid-chain. */
  | { kind: "provider-fallback"; from: string; to: string }
  /** Dwell was requested at the origin or destination, where it has no meaning. */
  | { kind: "dwell-ignored-at-endpoint"; waypointIndex: number };

/** Request body for `POST /directions/schedule`. */
export interface ScheduleDirectionsRequest {
  /** Origin…destination, in order. 2 to 25 entries. */
  waypoints: LngLat[];
  /** Per-waypoint constraints, aligned index-for-index. `null` means unconstrained. */
  schedules?: (WaypointSchedule | null)[];
  mode?: TravelMode;
  /** Trip anchor, resolved in the origin's zone. Mutually exclusive with `arriveBy`. */
  departAt?: string;
  /** Trip anchor, resolved in the destination's zone. Mutually exclusive with `departAt`. */
  arriveBy?: string;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  avoidClosures?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
  /** Reordering stops is refused while any waypoint carries a time window. */
  optimize?: boolean;
}

/**
 * Response for `POST /directions/schedule`. `routes` always holds exactly one
 * route — a scheduled trip is a chain, and alternates only exist for a single
 * unconstrained pair of points.
 */
export interface ScheduledDirectionsResult extends DirectionsResult {
  schedule: TripSchedule;
  fidelity: ScheduleFidelity;
  /** Declared support of the provider that served the trip. */
  temporal: TemporalCapabilities;
  warnings: SchedulePlanWarning[];
}
