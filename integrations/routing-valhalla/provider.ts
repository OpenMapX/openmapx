/**
 * Valhalla multi-modal routing service client (walking, cycling).
 * Default: Stadia Maps' hosted Valhalla (needs a key). Override via the
 * self-hosted `valhalla` service capability or
 * INTEGRATION_ROUTING_VALHALLA_ENDPOINT / INTEGRATION_ROUTING_VALHALLA_APIKEY;
 * self-hosted Valhalla works key-less.
 */

import type { DirectionsResult, Route, RouteLeg, RouteStep, TravelMode } from "@openmapx/core";
import { decodePolyline, fetchJson } from "@openmapx/core";
import type {
  ManeuverLane,
  ManeuverSign,
  MatchEdge,
  MatchOptions,
  MatchPoint,
  MatchResult,
  MatchTracePoint,
  RoutingOptions,
  RoutingProvider,
} from "@openmapx/integration-routing/types";

// Populated by setup(ctx): service-registry URL → ctx.config.endpoint
// (INTEGRATION_ROUTING_VALHALLA_ENDPOINT) → hardcoded fallback.
let VALHALLA_URL = "https://api.stadiamaps.com";
let VALHALLA_API_KEY: string | undefined;

/** Update the Valhalla base URL (called from setup() when service registry resolves it). */
export function setValhallaUrl(url: string): void {
  VALHALLA_URL = url;
}

/** Set the API key appended to requests (e.g. Stadia Maps); undefined for key-less instances. */
export function setValhallaApiKey(key: string | undefined): void {
  VALHALLA_API_KEY = key;
}

/** Build a Valhalla endpoint URL, appending `api_key` when configured. */
function endpoint(path: string): string {
  const url = `${VALHALLA_URL}${path}`;
  if (!VALHALLA_API_KEY) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(VALHALLA_API_KEY)}`;
}

const COSTING_MAP: Record<string, string> = {
  driving: "auto",
  walking: "pedestrian",
  cycling: "bicycle",
  motorcycle: "motorcycle",
};

/**
 * Per-maneuver penalty (seconds) for motorised costings — nudges routes toward
 * fewer turns than Valhalla's turn-happy ~5s default.
 */
const MANEUVER_PENALTY_SECONDS = 10;

const ELEVATION_INTERVAL = 30; // metres between elevation samples

/**
 * Current Valhalla releases encode lane directions and validity as bitmasks.
 * Older/hosted variants have also returned strings, arrays, or booleans, so the
 * compatibility forms stay accepted at this integration boundary.
 */
type ValhallaLaneFlag = number | boolean | string | string[];

interface ValhallaLaneRaw {
  directions?: number | string[];
  active?: ValhallaLaneFlag;
  valid?: ValhallaLaneFlag;
}

/** A single signage element on a Valhalla maneuver's `sign`. */
interface ValhallaSignElement {
  text: string;
  consecutive_count?: number;
}

interface ValhallaSign {
  exit_number_elements?: ValhallaSignElement[];
  exit_branch_elements?: ValhallaSignElement[];
  exit_toward_elements?: ValhallaSignElement[];
  exit_name_elements?: ValhallaSignElement[];
}

interface ValhallaManeuver {
  type: number;
  instruction: string;
  length: number; // km
  time: number; // seconds
  begin_shape_index: number;
  end_shape_index: number;
  street_names?: string[];
  lanes?: ValhallaLaneRaw[];
  // Voice-optimized phrasings + signage. Present in the standard narrative
  // output; absent on engines/old builds — consumers fall back gracefully.
  verbal_transition_alert_instruction?: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  verbal_succinct_transition_instruction?: string;
  roundabout_exit_count?: number;
  sign?: ValhallaSign;
}

interface ValhallaLeg {
  shape: string; // polyline6 encoded
  summary: { length: number; time: number };
  maneuvers: ValhallaManeuver[];
  elevation?: number[];
}

interface ValhallaLocation {
  lat: number;
  lon: number;
  original_index?: number;
}

interface ValhallaTrip {
  summary: { length: number; time: number };
  legs: ValhallaLeg[];
  locations?: ValhallaLocation[];
}

interface ValhallaResponse {
  trip: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
}

/**
 * Discriminated union mirroring Valhalla's `date_time` shape: type 0 carries
 * no value (engine uses "now"), types 1 and 2 require an explicit wall-clock.
 */
type ValhallaDateTime = { type: 0 } | { type: 1; value: string } | { type: 2; value: string };

/**
 * Build Valhalla's `date_time` object from routing options.
 *
 * Valhalla treats requests without `date_time` as time-agnostic, which means it
 * ignores time-conditional OSM access tags (school zones, restricted hours,
 * ferry schedules) and skips predicted-speed lookups even when historical
 * traffic tiles exist. Sending `{ type: 0 }` (current departure) by default
 * costs nothing and unlocks both behaviours.
 *
 * Per Valhalla API: type 0 = current depart, 1 = depart at, 2 = arrive by.
 * `value` is `YYYY-MM-DDTHH:mm` in the local time zone of the route origin.
 *
 * Throws if both `departAt` and `arriveBy` are set; the API handler also
 * rejects this case with 400, but enforcing it here protects future callers
 * that compose the provider directly.
 */
function buildDateTime(options: RoutingOptions): ValhallaDateTime {
  if (options.arriveBy && options.departAt) {
    throw new Error("departAt and arriveBy are mutually exclusive");
  }
  if (options.arriveBy) return { type: 2, value: options.arriveBy };
  if (options.departAt) return { type: 1, value: options.departAt };
  return { type: 0 };
}

/**
 * Map a Valhalla maneuver type enum to the normalized { type, modifier } shape.
 * Enum values follow Valhalla's documented `maneuver.type` table.
 * Exported for testing.
 */
export function valhallaManeuverType(t: number): { type: string; modifier?: string } {
  switch (t) {
    // 1-3 kStart{,Right,Left}
    case 1:
    case 2:
    case 3:
      return { type: "depart" };
    // 4-6 kDestination{,Right,Left}
    case 4:
    case 5:
    case 6:
      return { type: "arrive" };
    // Turns (9-16). NB Valhalla's left family is 14 kSharpLeft, 15 kLeft,
    // 16 kSlightLeft — mirror of the right family, NOT shifted.
    case 9:
      return { type: "turn", modifier: "slight right" };
    case 10:
      return { type: "turn", modifier: "right" };
    case 11:
      return { type: "turn", modifier: "sharp right" };
    case 12: // kUturnRight — only a left U-turn glyph exists, used for both
    case 13: // kUturnLeft
      return { type: "turn", modifier: "uturn" };
    case 14:
      return { type: "turn", modifier: "sharp left" };
    case 15:
      return { type: "turn", modifier: "left" };
    case 16:
      return { type: "turn", modifier: "slight left" };
    // Ramps (18/19) and exits (20/21) — a fork off the through road.
    case 18: // kRampRight
    case 20: // kExitRight
      return { type: "fork", modifier: "right" };
    case 19: // kRampLeft
    case 21: // kExitLeft
      return { type: "fork", modifier: "left" };
    // Staying on the current road is distinct from taking a branch. Preserve
    // that distinction so the UI can use a gentle directional arrow and prefer
    // through lanes rather than drawing a fork/exit glyph.
    case 22: // kStayStraight
      return { type: "keep", modifier: "straight" };
    case 23: // kStayRight
      return { type: "keep", modifier: "right" };
    case 24: // kStayLeft
      return { type: "keep", modifier: "left" };
    // Merges (25 kMerge, 37 kMergeRight, 38 kMergeLeft).
    case 25:
    case 37:
    case 38:
      return { type: "merge" };
    // Roundabouts (26 enter, 27 exit).
    case 26:
    case 27:
      return { type: "roundabout" };
    // Everything else proceeds straight, with no dedicated glyph: kNone (0),
    // kBecomes (7), kContinue (8), kRampStraight (17),
    // ferry (28-29), transit (30-36), and indoor/pedestrian (39-43).
    default:
      return { type: "turn", modifier: "straight" };
  }
}

const VALHALLA_LANE_BITS = [
  [1, "none"],
  [2, "through"],
  [4, "sharp_left"],
  [8, "left"],
  [16, "slight_left"],
  [32, "slight_right"],
  [64, "right"],
  [128, "sharp_right"],
  [256, "reverse"],
  [512, "merge_to_left"],
  [1024, "merge_to_right"],
] as const;

/** Decode Valhalla's documented lane-direction bitmask (or a legacy array). */
function laneDirections(value: ValhallaLaneRaw["directions"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  return VALHALLA_LANE_BITS.filter(([bit]) => (value & bit) !== 0).map(([, token]) => token);
}

/** True when a Valhalla lane flag is set (positive bitmask or legacy value). */
function laneFlagSet(flag: ValhallaLaneFlag | undefined): boolean {
  if (Array.isArray(flag)) return flag.length > 0;
  if (typeof flag === "string") return flag.length > 0;
  if (typeof flag === "number") return flag > 0;
  return Boolean(flag);
}

/** The active indication string from a Valhalla lane flag, when it carries one. */
function laneFlagIndication(
  flag: ValhallaLaneFlag | undefined,
  directions: string[],
): string | undefined {
  if (Array.isArray(flag)) return flag[0];
  if (typeof flag === "string" && flag.length > 0) return flag;
  if (typeof flag === "number") {
    const active = laneDirections(flag);
    return active.find((candidate) => directions.includes(candidate)) ?? active[0];
  }
  return undefined;
}

/** Lane guidance from a Valhalla maneuver, when present. Exported for testing. */
export function valhallaLanes(maneuver: ValhallaManeuver): ManeuverLane[] | undefined {
  if (!maneuver.lanes || maneuver.lanes.length === 0) return undefined;
  return maneuver.lanes.map((l) => {
    const indications = laneDirections(l.directions);
    const lane: ManeuverLane = {
      indications,
      valid: laneFlagSet(l.valid) || laneFlagSet(l.active),
    };
    const active =
      laneFlagIndication(l.active, indications) ?? laneFlagIndication(l.valid, indications);
    if (active) lane.active = active;
    return lane;
  });
}

/** Map a Valhalla maneuver `sign` to the normalized {@link ManeuverSign}. Exported for testing. */
export function valhallaSign(sign: ValhallaSign | undefined): ManeuverSign | undefined {
  if (!sign) return undefined;
  const texts = (els: ValhallaSignElement[] | undefined): string[] | undefined => {
    const list = els?.map((e) => e.text).filter((t): t is string => Boolean(t));
    return list && list.length > 0 ? list : undefined;
  };
  const out: ManeuverSign = {};
  const exitNumbers = texts(sign.exit_number_elements);
  const exitBranches = texts(sign.exit_branch_elements);
  const exitToward = texts(sign.exit_toward_elements);
  const exitNames = texts(sign.exit_name_elements);
  if (exitNumbers) out.exitNumbers = exitNumbers;
  if (exitBranches) out.exitBranches = exitBranches;
  if (exitToward) out.exitToward = exitToward;
  if (exitNames) out.exitNames = exitNames;
  return Object.keys(out).length > 0 ? out : undefined;
}

function transformLeg(leg: ValhallaLeg): RouteLeg {
  const coords = decodePolyline(leg.shape, 6);
  const steps: RouteStep[] = leg.maneuvers.map((m) => ({
    instruction: m.instruction,
    distance: m.length * 1000, // km -> metres
    duration: m.time,
    coordinates: coords.slice(m.begin_shape_index, m.end_shape_index + 1),
    maneuver: valhallaManeuverType(m.type),
    lanes: valhallaLanes(m),
    verbalAlert: m.verbal_transition_alert_instruction,
    verbalPre: m.verbal_pre_transition_instruction,
    verbalPost: m.verbal_post_transition_instruction,
    verbalSuccinct: m.verbal_succinct_transition_instruction,
    roundaboutExitCount: m.roundabout_exit_count,
    sign: valhallaSign(m.sign),
  }));

  const firstNamed = leg.maneuvers.find((m) => m.street_names && m.street_names.length > 0);
  const summary = firstNamed?.street_names?.[0] ? `via ${firstNamed.street_names[0]}` : undefined;

  return {
    distance: leg.summary.length * 1000, // km -> metres
    duration: leg.summary.time,
    geometry: coords,
    steps,
    summary,
  };
}

function transformTrip(trip: ValhallaTrip, mode: TravelMode): Route {
  const legs = trip.legs.map(transformLeg);

  const allCoords = legs.flatMap((leg) => leg.geometry);
  const steps: RouteStep[] = legs.flatMap((leg) => leg.steps);

  // Build "via [primary road]" from first leg's first named maneuver
  const firstNamed = trip.legs[0]?.maneuvers.find(
    (m) => m.street_names && m.street_names.length > 0,
  );
  const summary = firstNamed?.street_names?.[0] ? `via ${firstNamed.street_names[0]}` : undefined;

  // Concatenate elevation arrays from all legs (if present)
  const hasElevation = trip.legs.some((leg) => leg.elevation && leg.elevation.length > 0);
  const elevation = hasElevation ? trip.legs.flatMap((leg) => leg.elevation ?? []) : undefined;

  return {
    distance: trip.summary.length * 1000, // km -> metres
    duration: trip.summary.time,
    geometry: allCoords,
    legs,
    steps,
    mode,
    summary,
    ...(elevation && { elevation, elevationInterval: ELEVATION_INTERVAL }),
  };
}

/**
 * Subset of Valhalla's `trace_attributes` response that we consume. The full
 * shape includes ~30 attribute groups; we only request and parse the ones
 * needed for the {@link MatchResult} contract.
 *
 * https://valhalla.github.io/valhalla/api/map-matching/api-reference/
 */
interface ValhallaTraceEdge {
  way_id?: number;
  length?: number; // km
  speed?: number; // km/h
  speed_limit?: number; // km/h (posted)
  surface?: string;
  names?: string[];
  begin_shape_index?: number;
  end_shape_index?: number;
  end_node?: { traffic_signal?: boolean };
}

interface ValhallaTraceMatchedPoint {
  lat?: number;
  lon?: number;
  type?: "matched" | "interpolated" | "unmatched";
  edge_index?: number;
  distance_along_edge?: number; // 0–1 ratio along the matched edge
  distance_from_trace_point?: number; // metres
}

interface ValhallaTraceAttributesResponse {
  shape?: string;
  edges?: ValhallaTraceEdge[];
  matched_points?: ValhallaTraceMatchedPoint[];
}

export const TRACE_ATTRIBUTE_FILTER = [
  "edge.way_id",
  "edge.length",
  "edge.speed",
  "edge.speed_limit",
  "edge.surface",
  "edge.names",
  "edge.begin_shape_index",
  "edge.end_shape_index",
  "node.traffic_signal",
  "matched.point",
  "matched.type",
  "matched.edge_index",
  "matched.distance_along_edge",
  "matched.distance_from_trace_point",
  "shape",
] as const;

export function transformTraceEdge(edge: ValhallaTraceEdge): MatchEdge {
  return {
    wayId: edge.way_id,
    length: (edge.length ?? 0) * 1000, // km -> metres
    speed: edge.speed,
    // Valhalla returns km/h; absent/0 means unknown — passed through as-is.
    // The client treats <=0 as null.
    speedLimit: edge.speed_limit,
    surface: edge.surface,
    names: edge.names,
    beginShapeIndex: edge.begin_shape_index ?? 0,
    endShapeIndex: edge.end_shape_index ?? 0,
    endNodeTrafficSignal: edge.end_node?.traffic_signal,
  };
}

function transformMatchedPoint(point: ValhallaTraceMatchedPoint): MatchPoint {
  return {
    lat: point.lat ?? 0,
    lng: point.lon ?? 0,
    type: point.type ?? "unmatched",
    edgeIndex: point.edge_index,
    // Pass through unchanged: Valhalla returns this as a 0–1 ratio along the
    // edge. Consumers multiply by `edges[edge_index].length` (metres) to get
    // an absolute offset.
    distanceAlongEdgeRatio: point.distance_along_edge,
    distanceFromTracePoint: point.distance_from_trace_point,
  };
}

/**
 * Build the per-mode Valhalla `costing_options` from the avoid flags. Each is a
 * 0–1 weight where 0 means "avoid": `use_highways`, `use_tolls`, `use_ferry`. Motorised
 * costings (`auto`, `motorcycle`) also get a raised `maneuver_penalty` for fewer turns.
 */
export function buildCostingOptions(
  options: RoutingOptions,
  costing: string,
): Record<string, unknown> {
  const costingOptions: Record<string, unknown> = {};
  if (options.avoidHighways) costingOptions.use_highways = 0;
  if (options.avoidTolls) costingOptions.use_tolls = 0;
  if (options.avoidFerries) costingOptions.use_ferry = 0;
  if (costing === "auto" || costing === "motorcycle") {
    costingOptions.maneuver_penalty = MANEUVER_PENALTY_SECONDS;
  }
  // Valhalla enables all four speed sources (incl. "current"/live) by default
  // when speed_types is omitted, so the false branch here is what actually
  // matters: it deliberately excludes live speeds. Callers decide the default
  // per costing (motorised on, bike/pedestrian off) — this fn just honours it.
  costingOptions.speed_types = options.useLiveTraffic
    ? ["freeflow", "constrained", "predicted", "current"]
    : ["freeflow", "constrained", "predicted"];
  return costingOptions;
}

type ValhallaExclusions = {
  exclude_locations?: Array<{ lon: number; lat: number }>;
  exclude_polygons?: Array<Array<[number, number]>>;
};

/**
 * Translate optional exclusion geometry from `RoutingOptions` into the
 * Valhalla request fields. Each key is omitted entirely when empty so the
 * engine receives a clean request without no-op empty arrays.
 */
export function buildExclusions(options: RoutingOptions): ValhallaExclusions {
  const result: ValhallaExclusions = {};
  if (options.excludeLocations?.length) {
    result.exclude_locations = options.excludeLocations.map(([lon, lat]) => ({ lon, lat }));
  }
  if (options.excludePolygons?.length) {
    result.exclude_polygons = options.excludePolygons;
  }
  return result;
}

export const valhallaService: RoutingProvider = {
  id: "valhalla",
  supportedModes: ["walking", "cycling", "driving", "motorcycle"] as TravelMode[],
  supportsTimeAware: true,

  async getRoute(
    waypoints: [number, number][],
    mode: TravelMode,
    options: RoutingOptions = {},
  ): Promise<DirectionsResult> {
    const costingOptions = buildCostingOptions(options, COSTING_MAP[mode]);

    const locations = waypoints.map((wp) => ({ lon: wp[0], lat: wp[1], type: "break" as const }));

    const body: Record<string, unknown> = {
      locations,
      costing: COSTING_MAP[mode],
      costing_options: { [COSTING_MAP[mode]]: costingOptions },
      directions_options: {
        units: options.units === "imperial" ? "miles" : "km",
        language: options.lang ?? "en",
      },
      turn_lanes: true,
      date_time: buildDateTime(options),
      elevation_interval: ELEVATION_INTERVAL,
      ...buildExclusions(options),
    };

    // Valhalla only supports alternates with exactly 2 waypoints
    if (waypoints.length === 2) {
      body.alternates = 3;
    }

    const data = await fetchJson<ValhallaResponse>(endpoint("/route"), {
      timeoutMs: 15_000,
      userAgent: null,
      headers: { "Content-Type": "application/json" },
      errorMessage: ({ status }) => `Valhalla error ${status}`,
      init: { method: "POST", body: JSON.stringify(body) },
    });
    const travelMode = mode as TravelMode;

    const routes: Route[] = [transformTrip(data.trip, travelMode)];
    if (data.alternates) {
      for (const alt of data.alternates) {
        routes.push(transformTrip(alt.trip, travelMode));
      }
    }

    return {
      waypoints,
      routes,
      activeRouteIndex: 0,
    };
  },

  async optimizeRoute(
    waypoints: [number, number][],
    mode: TravelMode,
    options: RoutingOptions = {},
  ): Promise<DirectionsResult> {
    const costingOptions = buildCostingOptions(options, COSTING_MAP[mode]);

    const locations = waypoints.map((wp) => ({
      lon: wp[0],
      lat: wp[1],
      type: "break" as const,
    }));

    const body: Record<string, unknown> = {
      locations,
      costing: COSTING_MAP[mode],
      costing_options: { [COSTING_MAP[mode]]: costingOptions },
      directions_options: {
        units: options.units === "imperial" ? "miles" : "km",
        language: options.lang ?? "en",
      },
      turn_lanes: true,
      date_time: buildDateTime(options),
      elevation_interval: ELEVATION_INTERVAL,
    };

    const data = await fetchJson<ValhallaResponse>(endpoint("/optimized_route"), {
      timeoutMs: 15_000,
      userAgent: null,
      headers: { "Content-Type": "application/json" },
      errorMessage: ({ status }) => `Valhalla optimized_route error ${status}`,
      init: { method: "POST", body: JSON.stringify(body) },
    });
    const travelMode = mode as TravelMode;

    const routes: Route[] = [transformTrip(data.trip, travelMode)];

    // Extract optimized order from trip.locations[].original_index
    const optimizedOrder =
      data.trip.locations?.map((loc) => loc.original_index ?? 0) ?? waypoints.map((_, i) => i);

    return {
      waypoints,
      routes,
      activeRouteIndex: 0,
      optimizedOrder,
    };
  },

  /**
   * Snap a recorded GPS trace to the road network via Valhalla's `trace_attributes`
   * endpoint. Backed by Meili (HMM map matcher) which handles noisy GPS far better
   * than OSRM's `match` service and returns per-edge OSM way ids and surface tags.
   */
  async getMatch(
    trace: MatchTracePoint[],
    mode: TravelMode,
    options: MatchOptions = {},
  ): Promise<MatchResult> {
    if (trace.length < 2) {
      throw new Error("trace requires at least 2 points");
    }

    const shape = trace.map((p) => {
      const point: { lat: number; lon: number; time?: number } = { lat: p.lat, lon: p.lng };
      if (p.time) {
        // Valhalla expects unix epoch seconds; ISO inputs get converted here.
        const ms = Date.parse(p.time);
        if (!Number.isNaN(ms)) point.time = Math.round(ms / 1000);
      }
      return point;
    });

    const body = {
      shape,
      shape_match: options.shapeMatch ?? "walk_or_snap",
      costing: COSTING_MAP[mode],
      filters: { attributes: TRACE_ATTRIBUTE_FILTER, action: "include" },
    };

    const data = await fetchJson<ValhallaTraceAttributesResponse>(endpoint("/trace_attributes"), {
      timeoutMs: 15_000,
      userAgent: null,
      headers: { "Content-Type": "application/json" },
      errorMessage: ({ status }) => `Valhalla trace_attributes error ${status}`,
      init: { method: "POST", body: JSON.stringify(body) },
    });

    return {
      geometry: data.shape ? decodePolyline(data.shape, 6) : [],
      edges: (data.edges ?? []).map(transformTraceEdge),
      points: (data.matched_points ?? []).map(transformMatchedPoint),
      mode,
    };
  },
};
