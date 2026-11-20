import { randomUUID } from "node:crypto";
import { type CoverageTraceResponse, traceRouteCoverage } from "./live-coverage.js";
import { readTrafficProof } from "./traffic-proof.js";
/**
 * Valhalla multi-modal routing service client (walking, cycling).
 * Default: Stadia Maps' hosted Valhalla (needs a key). Override via the
 * self-hosted `valhalla` service capability or
 * INTEGRATION_ROUTING_VALHALLA_ENDPOINT / INTEGRATION_ROUTING_VALHALLA_APIKEY;
 * self-hosted Valhalla works key-less.
 */

import type {
  DirectionsResult,
  Route,
  RouteLeg,
  RouteStep,
  RoutingTrafficProof,
  TravelMode,
} from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";
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
import {
  sanitizeValhallaExclusions,
  type LngLat as ValhallaLngLat,
} from "./valhalla-exclusions.js";
import {
  composeWalkingSteps,
  type LocatedEdge,
  longestStreet,
  type NameLookup,
  nameLookups,
  nameStretches,
  nearestStreetName,
  planWalkingLeg,
  type WalkEdge,
} from "./walking-guidance.js";

const DEFAULT_VALHALLA_URL = "https://api.stadiamaps.com";

/** One generation's Valhalla configuration, resolved when the integration activates. */
export interface ValhallaSettings {
  /** The instance to query; undefined means Stadia Maps' hosted Valhalla. */
  url?: string;
  /** Key appended to requests (e.g. Stadia Maps); undefined for key-less instances. */
  apiKey?: string;
  /**
   * Master switch for the traffic-aware request additions. The operator can
   * turn it off if bidirectional route choice regresses somewhere.
   */
  bidirectionalAlternates: boolean;
}

function hostedByStadia(url: string | undefined): boolean {
  try {
    return /(^|\.)stadiamaps\.com$/.test(
      new URL(url ?? DEFAULT_VALHALLA_URL).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

/**
 * Manifest sourceId of the endpoint that answers requests, so a route credits
 * Stadia Maps only when Stadia actually computed it.
 */
export function valhallaSourceIds(url: string | undefined): string[] {
  return [hostedByStadia(url) ? "stadia-maps" : "valhalla"];
}

/** A non-2xx Valhalla answer, with the engine's own error code when its body names one. */
export class ValhallaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: number | undefined,
    label: string,
    detail: string | undefined,
  ) {
    super(`${label} ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ValhallaHttpError";
  }
}

/** Valhalla answers a few MiB for long routes with elevation and alternates. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** POSTs JSON to one generation's Valhalla instance through the host client. */
interface ValhallaClient {
  post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<T>;
  readonly hostedByStadia: boolean;
  readonly bidirectionalAlternates: boolean;
}

/** Valhalla's error code and a bounded copy of its diagnostic body. */
function errorDetail(body: string): { code?: number; detail?: string } {
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 512) || undefined;
  try {
    const parsed = JSON.parse(body) as { error_code?: unknown };
    return {
      ...(typeof parsed.error_code === "number" ? { code: parsed.error_code } : {}),
      detail,
    };
  } catch {
    return { detail };
  }
}

function valhallaClient(http: HttpClient, settings: ValhallaSettings): ValhallaClient {
  const base = settings.url ?? DEFAULT_VALHALLA_URL;
  return {
    hostedByStadia: hostedByStadia(settings.url),
    bidirectionalAlternates: settings.bidirectionalAlternates,
    async post<T>(path: string, body: Record<string, unknown>, timeoutMs: number, label: string) {
      // Error bodies come back as bounded text, so Valhalla's error code survives.
      const response = await http.postText(`${base}${path}`, JSON.stringify(body), {
        ...(settings.apiKey ? { params: { api_key: settings.apiKey } } : {}),
        headers: { "Content-Type": "application/json" },
        contentTypes: ["application/json"],
        fallbackContentType: "application/json",
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        const { code, detail } = errorDetail(response.body);
        throw new ValhallaHttpError(response.status, code, label, detail);
      }
      return JSON.parse(response.body) as T;
    },
  };
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
/** Valhalla's production service limit is two alternates (three routes total). */
const REQUESTED_ALTERNATES = 2;

/** A coverage trace is a cheap walk of a known path; a slow one leaves coverage unknown. */
const COVERAGE_TRACE_TIMEOUT_MS = 3_000;

/**
 * Attach live-speed coverage evidence to routes the engine proved against its
 * current traffic write. Coverage is extra evidence: a failed trace leaves it
 * absent and never fails the route.
 */
async function attachTrafficCoverage(
  client: ValhallaClient,
  routes: Route[],
  proof: RoutingTrafficProof,
  costingOptions: Record<string, unknown>,
): Promise<void> {
  const post = (body: Record<string, unknown>) =>
    client.post<CoverageTraceResponse>(
      "/trace_attributes",
      body,
      COVERAGE_TRACE_TIMEOUT_MS,
      "Valhalla coverage trace error",
    );
  const coverage = await Promise.all(
    routes.map((route) =>
      traceRouteCoverage(route, proof, costingOptions, post).catch(() => undefined),
    ),
  );
  routes.forEach((route, index) => {
    const evidence = coverage[index];
    if (evidence) route.trafficCoverage = evidence;
  });
}

/** Walking guidance lookups are refinements: a slow one leaves Valhalla's own steps. */
const WALKING_LOOKUP_TIMEOUT_MS = 4_000;
/** Street-name lookups per request; stretches past this keep no name. */
const MAX_NAME_LOOKUPS = 60;

/** Each edge's use along a leg's own shape, for finding its crosswalks. */
async function walkingEdges(
  client: ValhallaClient,
  shape: string,
): Promise<WalkEdge[] | undefined> {
  const data = await client
    .post<{ edges?: WalkEdge[] }>(
      "/trace_attributes",
      {
        encoded_polyline: shape,
        shape_match: "walk_or_snap",
        costing: "pedestrian",
        filters: {
          attributes: ["edge.use", "edge.begin_shape_index", "edge.end_shape_index"],
          action: "include",
        },
      },
      WALKING_LOOKUP_TIMEOUT_MS,
      "Valhalla walking trace error",
    )
    .catch(() => undefined);
  return Array.isArray(data?.edges) ? data.edges : undefined;
}

/** The street nearest each lookup's point, in one `/locate` request. */
async function streetNamesNear(
  client: ValhallaClient,
  lookups: ReadonlyArray<Pick<NameLookup, "field" | "point" | "radius">>,
): Promise<Array<string | undefined>> {
  if (lookups.length === 0) return [];
  const data = await client
    .post<Array<{ edges?: LocatedEdge[] | null }>>(
      "/locate",
      {
        locations: lookups.map(({ point: [lon, lat], radius }) => ({ lon, lat, radius })),
        costing: "pedestrian",
        verbose: true,
      },
      WALKING_LOOKUP_TIMEOUT_MS,
      "Valhalla locate error",
    )
    .catch(() => undefined);
  return lookups.map((lookup, i) =>
    Array.isArray(data) ? nearestStreetName(data[i]?.edges, lookup) : undefined,
  );
}

/**
 * Rewrite walking steps so they name streets and crossings instead of "the
 * walkway" (see walking-guidance.ts). `routes[i]` came from `trips[i]`.
 */
async function refineWalkingRoutes(
  client: ValhallaClient,
  routes: Route[],
  trips: ValhallaTrip[],
  lang: string | undefined,
): Promise<void> {
  const legs = trips.flatMap((trip, r) =>
    trip.legs.flatMap((leg, l) => {
      const routeLeg = routes[r]?.legs[l];
      return routeLeg && routeLeg.steps.length === leg.maneuvers.length ? [{ leg, routeLeg }] : [];
    }),
  );
  const plans = await Promise.all(
    legs.map(async ({ leg, routeLeg }) =>
      planWalkingLeg(
        leg.maneuvers,
        routeLeg.steps,
        routeLeg.geometry,
        await walkingEdges(client, leg.shape),
      ),
    ),
  );
  const lookups = plans
    .flatMap((plan, p) => nameLookups(plan).map((lookup) => ({ p, ...lookup })))
    .slice(0, MAX_NAME_LOOKUPS);
  const names = await streetNamesNear(client, lookups);
  plans.forEach((plan, p) => {
    nameStretches(
      plan,
      lookups.flatMap((lookup, i) => (lookup.p === p ? [{ ...lookup, name: names[i] }] : [])),
    );
    const leg = legs[p].routeLeg;
    leg.steps = composeWalkingSteps(plan, lang);
    const street = longestStreet(leg.steps);
    if (street) leg.summary = `via ${street}`;
  });
  for (const route of routes) {
    route.steps = route.legs.flatMap((leg) => leg.steps);
    const street = longestStreet(route.steps);
    if (street) route.summary = `via ${street}`;
  }
}

interface ValhallaLaneRaw {
  directions?: number;
  active?: number;
  valid?: number;
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
  length: number; // requested miles or kilometers
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
  /** Serialised only when true — absent (never false) on ramps and unflagged edges. */
  highway?: boolean;
  bearing_before?: number;
  bearing_after?: number;
}

interface ValhallaLeg {
  shape: string; // polyline6 encoded
  summary: { length: number; time: number };
  maneuvers: ValhallaManeuver[];
  elevation?: number[];
  elevation_interval?: number;
}

interface ValhallaLocation {
  lat: number;
  lon: number;
  original_index?: number;
}

interface ValhallaTrip {
  /**
   * `time_<name>` keys are emitted per requested recosting. We request one named
   * `baseline`; Valhalla sends `null` when a leg could not be recosted.
   */
  summary: {
    length: number;
    time: number;
    time_baseline?: number | null;
    /** Whether any edge of the trip is a toll road. */
    has_toll?: boolean;
  };
  legs: ValhallaLeg[];
  units?: "miles" | "mi" | "kilometers" | "km";
  locations?: ValhallaLocation[];
}

interface ValhallaResponse {
  openmapx_traffic_proof?: unknown;
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
    // Pedestrian/indoor: 39 kElevatorEnter, 40 kStepsEnter, 41 kEscalatorEnter.
    // Surface a dedicated glyph (escalator maps to stairs — closest icon) so foot
    // routing shows "take the lift/stairs" instead of a bare straight arrow.
    case 39:
      return { type: "elevator" };
    case 40:
    case 41:
      return { type: "stairs" };
    // Everything else proceeds straight, with no dedicated glyph: kNone (0),
    // kBecomes (7), kContinue (8), kRampStraight (17), ferry (28-29),
    // transit (30-36), and building enter/exit (42-43).
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

/** Decode Valhalla's lane-direction bitmask. */
function laneDirections(value: ValhallaLaneRaw["directions"]): string[] {
  if (typeof value !== "number" || !Number.isFinite(value)) return [];
  return VALHALLA_LANE_BITS.filter(([bit]) => (value & bit) !== 0).map(([, token]) => token);
}

/** True when a Valhalla lane bitmask is set. */
function laneFlagSet(flag: number | undefined): boolean {
  return typeof flag === "number" && Number.isFinite(flag) && flag > 0;
}

/** The active indication string from a Valhalla lane flag, when it carries one. */
function laneFlagIndication(flag: number | undefined, directions: string[]): string | undefined {
  if (typeof flag === "number") {
    const active = laneDirections(flag);
    return active.find((candidate) => directions.includes(candidate)) ?? active[0];
  }
  return undefined;
}

/** Lane guidance from a Valhalla maneuver, when present. Exported for testing. */
export function valhallaLanes(maneuver: ValhallaManeuver): ManeuverLane[] | undefined {
  if (!maneuver.lanes || maneuver.lanes.length === 0) return undefined;
  // Valhalla serializes nonzero lane states only. Once this maneuver reports
  // guidance, omitted flags on its other lanes represent zero, not unknown.
  const reported = maneuver.lanes.some(
    (lane) => lane.valid !== undefined || lane.active !== undefined,
  );
  const preferredReported = maneuver.lanes.some((lane) => lane.active !== undefined);
  return maneuver.lanes.map((l) => {
    const indications = laneDirections(l.directions);
    const lane: ManeuverLane = {
      indications,
      ...(reported ? { valid: laneFlagSet(l.valid) || laneFlagSet(l.active) } : {}),
      ...(preferredReported ? { preferred: laneFlagSet(l.active) } : {}),
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

function transformLeg(leg: ValhallaLeg, distanceMetresPerUnit: number): RouteLeg {
  const coords = decodePolyline(leg.shape, 6);
  const steps: RouteStep[] = leg.maneuvers.map((m) => ({
    instruction: m.instruction,
    distance: m.length * distanceMetresPerUnit,
    duration: m.time,
    coordinates: coords.slice(m.begin_shape_index, m.end_shape_index + 1),
    roadNames: m.street_names?.length ? m.street_names : undefined,
    maneuver: valhallaManeuverType(m.type),
    lanes: valhallaLanes(m),
    verbalAlert: m.verbal_transition_alert_instruction,
    verbalPre: m.verbal_pre_transition_instruction,
    verbalPost: m.verbal_post_transition_instruction,
    verbalSuccinct: m.verbal_succinct_transition_instruction,
    roundaboutExitCount: m.roundabout_exit_count,
    sign: valhallaSign(m.sign),
    motorway: m.highway === true ? true : undefined,
    bearingBefore: typeof m.bearing_before === "number" ? m.bearing_before : undefined,
    bearingAfter: typeof m.bearing_after === "number" ? m.bearing_after : undefined,
  }));

  const firstNamed = leg.maneuvers.find((m) => m.street_names && m.street_names.length > 0);
  const summary = firstNamed?.street_names?.[0] ? `via ${firstNamed.street_names[0]}` : undefined;

  return {
    distance: leg.summary.length * distanceMetresPerUnit,
    duration: leg.summary.time,
    geometry: coords,
    steps,
    summary,
  };
}

export function transformTrip(
  trip: ValhallaTrip,
  mode: TravelMode,
  requestedUnits: RoutingOptions["units"] = "metric",
): Route {
  // Valhalla narrates in the requested units. Normalize only numeric fields
  // before exposing them through Route's metre-based contract.
  const miles =
    trip.units === "miles" || trip.units === "mi"
      ? true
      : trip.units === "kilometers" || trip.units === "km"
        ? false
        : requestedUnits === "imperial";
  const distanceMetresPerUnit = miles ? 1609.344 : 1000;
  const elevationMetresPerUnit = miles ? 0.3048 : 1;
  const legs = trip.legs.map((leg) => transformLeg(leg, distanceMetresPerUnit));

  const allCoords = legs.flatMap((leg) => leg.geometry);
  const steps: RouteStep[] = legs.flatMap((leg) => leg.steps);

  // Build "via [primary road]" from first leg's first named maneuver
  const firstNamed = trip.legs[0]?.maneuvers.find(
    (m) => m.street_names && m.street_names.length > 0,
  );
  const summary = firstNamed?.street_names?.[0] ? `via ${firstNamed.street_names[0]}` : undefined;

  // Concatenate elevation arrays from all legs (if present)
  const hasElevation = trip.legs.some((leg) => leg.elevation && leg.elevation.length > 0);
  const elevation = hasElevation
    ? trip.legs.flatMap((leg) =>
        (leg.elevation ?? []).map((value) => value * elevationMetresPerUnit),
      )
    : undefined;
  // The request interval is metres, but Valhalla echoes it in feet for miles.
  const returnedInterval = trip.legs.find((leg) => leg.elevation?.length)?.elevation_interval;
  const elevationInterval =
    typeof returnedInterval === "number" &&
    Number.isFinite(returnedInterval) &&
    returnedInterval > 0
      ? returnedInterval * elevationMetresPerUnit
      : ELEVATION_INTERVAL;
  const baselineDuration = trip.summary.time_baseline;

  return {
    distance: trip.summary.length * distanceMetresPerUnit,
    duration: trip.summary.time,
    ...(typeof baselineDuration === "number" &&
      Number.isFinite(baselineDuration) &&
      baselineDuration >= 0 && {
        baselineDuration,
      }),
    geometry: allCoords,
    legs,
    steps,
    mode,
    summary,
    ...(typeof trip.summary.has_toll === "boolean" && { hasTolls: trip.summary.has_toll }),
    ...(elevation && { elevation, elevationInterval }),
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
  end_node?: { traffic_signal?: boolean; admin_index?: number };
}

/** An administrative area referenced by `end_node.admin_index`. */
interface ValhallaTraceAdmin {
  country_code?: string;
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
  admins?: ValhallaTraceAdmin[];
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
  "node.admin_index",
  "admin.country_code",
  "matched.point",
  "matched.type",
  "matched.edge_index",
  "matched.distance_along_edge",
  "matched.distance_from_trace_point",
  "shape",
] as const;

export function transformTraceEdge(
  edge: ValhallaTraceEdge,
  admins: ValhallaTraceAdmin[] = [],
): MatchEdge {
  const adminIndex = edge.end_node?.admin_index;
  const countryCode = adminIndex === undefined ? undefined : admins[adminIndex]?.country_code;
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
    ...(countryCode ? { endNodeCountryCode: countryCode.toUpperCase() } : {}),
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
  if (costing === "bicycle") {
    if (options.bikeProfile)
      costingOptions.bicycle_type = {
        trekking: "hybrid",
        road: "road",
        gravel: "cross",
        mountain: "mountain",
      }[options.bikeProfile];
    // Penalties are relative to the bike type, and remain soft even in smooth mode.
    const surfacePenalty = { road: 0.75, trekking: 0.5, gravel: 0.25, mountain: 0.1 };
    costingOptions.avoid_bad_surfaces = options.bikePreferSmoothSurfaces
      ? 0.9
      : surfacePenalty[options.bikeProfile ?? "trekking"];
    if (options.bikeSpeedKmh !== undefined) costingOptions.cycling_speed = options.bikeSpeedKmh;
    if (options.bikeHillPreference && options.bikeHillPreference !== "default")
      costingOptions.use_hills = options.bikeHillPreference === "strongly-avoid" ? 0 : 0.1;
    if (options.bikePreferQuietRoads) costingOptions.use_roads = 0.1;
  }
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

function buildClosureSafeCostingOptions(
  options: RoutingOptions,
  mode: TravelMode,
): { costingOptions: Record<string, unknown>; usesCurrentClosures: boolean } {
  const usesCurrentClosures =
    options.useLiveTraffic === true &&
    (mode === "driving" || mode === "motorcycle") &&
    !options.departAt &&
    !options.arriveBy;
  const costingOptions = buildCostingOptions(
    { ...options, useLiveTraffic: usesCurrentClosures },
    COSTING_MAP[mode],
  );

  // A current live tile contains closure bits as well as speeds. Valhalla
  // otherwise applies those bits to explicit future requests, while bike and
  // pedestrian costings do not reliably apply them at all. Make every request
  // outside the verified depart-now motorised envelope ignore binary closures.
  // Valhalla refuses the key, even when false, beside a location's
  // `exclude_closures`, so it is only ever sent as true.
  if (!usesCurrentClosures) costingOptions.ignore_closures = true;
  return { costingOptions, usesCurrentClosures };
}

/** Speed sources for the comparison recosting: everything except live traffic. */
const BASELINE_SPEED_TYPES = ["freeflow", "constrained", "predicted"];

/**
 * Extra request fields that make live traffic actually influence route choice.
 *
 * `prioritize_bidirectional` is the important one. Valhalla picks
 * `timedep_forward` whenever the origin carries a `date_time` and the trip is
 * shorter than `max_timedep_distance` (500 km by default), and that algorithm
 * has no alternates implementation — so every ordinary trip silently came back
 * with a single route. Bidirectional A* has alternates and is itself time-aware
 * (its forward tree advances `seconds_from_now`, so the live-traffic fade still
 * applies); only its reverse tree is approximate, which `reverse_time_tracking`
 * softens by giving it an estimated start time.
 *
 * The bidirectional switch is limited to two-waypoint depart-now requests:
 * `arriveBy` uses `timedep_reverse`, which ignores the flag entirely, an
 * explicit `departAt` is better served by the exact time-dependent algorithm,
 * and with more waypoints there are no alternates to gain so there is no reason
 * to accept the reverse-tree approximation.
 *
 * `recostings` re-runs the chosen path without live speeds, which costs no extra
 * round trip and yields the traffic-free duration route cards compare against.
 */
export function buildTrafficRequestExtras(
  options: RoutingOptions,
  costing: string,
  costingOptions: Record<string, unknown>,
  waypointCount: number,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled || !options.useLiveTraffic) return {};

  // A recosting carries its costing options flat; nested under
  // `costing_options` Valhalla ignores them and recosts with live speeds.
  const extras: Record<string, unknown> = {
    recostings: [
      { costing, name: "baseline", ...costingOptions, speed_types: BASELINE_SPEED_TYPES },
    ],
  };

  const departNow = !options.departAt && !options.arriveBy;
  if (departNow && waypointCount === 2) {
    extras.prioritize_bidirectional = true;
    extras.reverse_time_tracking = "heuristic";
  }

  return extras;
}

/**
 * How far from a directed exclusion's heading an edge may run and still be
 * excluded. The opposite carriageway or direction runs about 180 degrees off;
 * a bend within a sampled edge stays well inside this.
 */
const DIRECTED_EXCLUSION_TOLERANCE_DEG = 45;

type ValhallaExclusions = {
  exclude_locations?: Array<{
    lon: number;
    lat: number;
    heading?: number;
    heading_tolerance?: number;
  }>;
  exclude_polygons?: Array<Array<[number, number]>>;
};

/**
 * Translate optional exclusion geometry from `RoutingOptions` into the
 * Valhalla request fields. Each key is omitted entirely when empty so the
 * engine receives a clean request without no-op empty arrays.
 */
export function buildExclusions(options: RoutingOptions): ValhallaExclusions {
  const sanitized = sanitizeValhallaExclusions({
    points: options.excludeLocations as ValhallaLngLat[] | undefined,
    directed: options.directedExclusions,
    polygons: options.excludePolygons as ValhallaLngLat[][] | undefined,
  });
  const result: ValhallaExclusions = {};
  // Valhalla correlates a heading-bearing exclusion only to edges running
  // within the tolerance of it, so the opposite direction keeps routing.
  const locations = [
    ...sanitized.points.map(([lon, lat]) => ({ lon, lat })),
    ...sanitized.directed.map(({ point: [lon, lat], heading }) => ({
      lon,
      lat,
      heading,
      heading_tolerance: DIRECTED_EXCLUSION_TOLERANCE_DEG,
    })),
  ];
  if (locations.length) result.exclude_locations = locations;
  if (sanitized.polygons.length) {
    result.exclude_polygons = sanitized.polygons;
  }
  return result;
}

/** Response shape for Valhalla's `sources_to_targets` matrix endpoint. */
interface ValhallaMatrixResponse {
  sources_to_targets: Array<
    Array<{ from_index: number; to_index: number; time: number | null; distance: number | null }>
  >;
}

interface ValhallaLocation {
  lon: number;
  lat: number;
  type: "break" | "through" | "via";
  waiting?: number;
  /** 0 lets an end snap onto a street only reachable through a closed road. */
  minimum_reachability?: number;
  search_filter?: { exclude_closures: false };
}

/**
 * Valhalla honours `waiting` on `break` locations only, and forces it to zero at
 * the origin and destination, so sending it there would be silently dropped.
 * Setting it lets the engine advance its own clock across a stop, which is what
 * makes the time-dependent costing on later legs reflect the later hour.
 *
 * https://valhalla.github.io/valhalla/api/route/api-reference/
 */
export function buildLocations(
  waypoints: [number, number][],
  options: RoutingOptions,
  localAccess?: RoutingOptions["localAccess"],
): ValhallaLocation[] {
  const last = waypoints.length - 1;
  return waypoints.map((wp, index) => {
    const dwell = options.dwellSeconds?.[index];
    const waiting = index > 0 && index < last && typeof dwell === "number" && dwell > 0 ? dwell : 0;
    const end =
      index === 0 ? localAccess?.origin : index === last ? localAccess?.destination : undefined;
    return {
      lon: wp[0],
      lat: wp[1],
      type: "break" as const,
      ...(waiting > 0 ? { waiting } : {}),
      ...(end ? { minimum_reachability: 0 } : {}),
      ...(end?.snapOntoClosure ? { search_filter: { exclude_closures: false as const } } : {}),
    };
  });
}

/** Valhalla found no path between the locations (error 442). */
function isNoPath(error: unknown): boolean {
  return error instanceof ValhallaHttpError && error.status === 400 && error.errorCode === 442;
}

/** Extra requests at most when an end is reachable only through a local-access road. */
const MAX_ACCESS_ATTEMPTS = 4;

/**
 * The location lists to try when an end near a road closed to all but local
 * access found no path: a location on the road at each access point, the
 * destination's before the origin's, first `through` (no U-turn), then `via`.
 * Valhalla lets a route leave or enter consecutive closed edges only at a
 * location on them, so a street behind the road is reached through it.
 */
export function localAccessAttempts(
  locations: readonly ValhallaLocation[],
  localAccess: NonNullable<RoutingOptions["localAccess"]>,
): ValhallaLocation[][] {
  const attempts: ValhallaLocation[][] = [];
  const at = (point: [number, number], type: "through" | "via"): ValhallaLocation => ({
    lon: point[0],
    lat: point[1],
    type,
    search_filter: { exclude_closures: false },
  });
  const ends = [
    { points: localAccess.destination?.accessPoints ?? [], index: locations.length - 1 },
    { points: localAccess.origin?.accessPoints ?? [], index: 1 },
  ];
  for (const { points, index } of ends) {
    for (const point of points) {
      for (const type of ["through", "via"] as const) {
        attempts.push([...locations.slice(0, index), at(point, type), ...locations.slice(index)]);
      }
    }
  }
  return attempts.slice(0, MAX_ACCESS_ATTEMPTS);
}

/**
 * The Valhalla routing provider of one generation. `settings` returns the
 * configuration resolved at activation, so a reload never keeps an older
 * endpoint or key.
 */
export function createValhallaService(
  http: HttpClient,
  settings: () => ValhallaSettings,
): RoutingProvider {
  return {
    id: "valhalla",
    priority: 10,
    supportedModes: ["walking", "cycling", "driving", "motorcycle"] as TravelMode[],
    supportsTimeAware: true,
    supportsExclusions: true,
    supportsDirectedExclusions: true,
    temporal: {
      tripDepartAt: "native",
      tripArriveBy: "native",
      dwell: "native",
      waypointDepartAfter: "emulated",
      waypointArriveBy: "emulated",
      timeDependentTravel: "native",
    },

    async getRoute(
      waypoints: [number, number][],
      mode: TravelMode,
      options: RoutingOptions = {},
    ): Promise<DirectionsResult> {
      const current = settings();
      const client = valhallaClient(http, current);
      const sourceIds = valhallaSourceIds(current.url);
      const { costingOptions, usesCurrentClosures } = buildClosureSafeCostingOptions(options, mode);
      const effectiveTrafficOptions = { ...options, useLiveTraffic: usesCurrentClosures };

      // Only a request that honours closures may relax its ends: a location's
      // `exclude_closures` beside `ignore_closures` is an engine error.
      const localAccess = usesCurrentClosures ? options.localAccess : undefined;
      const locations = buildLocations(waypoints, options, localAccess);

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
        ...buildTrafficRequestExtras(
          effectiveTrafficOptions,
          COSTING_MAP[mode],
          costingOptions,
          waypoints.length,
          client.bidirectionalAlternates,
        ),
      };

      // Valhalla only supports alternates with exactly 2 waypoints
      if (waypoints.length === 2) {
        body.alternates = REQUESTED_ALTERNATES;
      }
      // A destination on a closed road is reachable only by the bidirectional
      // search; the time-dependent forward search finds no path to it.
      if (localAccess) body.prioritize_bidirectional = true;

      const requestId = randomUUID();
      const startedAt = Date.now();
      if (usesCurrentClosures) body.openmapx_request_id = requestId;
      const post = (request: Record<string, unknown>) =>
        client.post<ValhallaResponse>("/route", request, 15_000, "Valhalla error");
      const data = await post(body).catch(async (error: unknown) => {
        if (!localAccess || !isNoPath(error)) throw error;
        // No alternates beside a location on the road: they need exactly two.
        const { alternates: _alternates, ...single } = body;
        for (const attempt of localAccessAttempts(locations, localAccess)) {
          try {
            return await post({ ...single, locations: attempt });
          } catch (retryError) {
            if (!isNoPath(retryError)) throw retryError;
          }
        }
        return post({ ...body, locations: buildLocations(waypoints, options) });
      });
      const travelMode = mode as TravelMode;
      const trafficProof =
        usesCurrentClosures && !client.hostedByStadia
          ? readTrafficProof(
              data.openmapx_traffic_proof,
              requestId,
              "route",
              COSTING_MAP[mode],
              startedAt,
            )
          : undefined;

      const trips = [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)];
      const routes: Route[] = trips.map((trip) => transformTrip(trip, travelMode, options.units));
      if (mode === "walking") await refineWalkingRoutes(client, routes, trips, options.lang);

      for (const route of routes) {
        route.sourceIds = sourceIds;
        if (trafficProof) route.trafficProof = trafficProof;
      }
      if (trafficProof) await attachTrafficCoverage(client, routes, trafficProof, costingOptions);

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
      const current = settings();
      const client = valhallaClient(http, current);
      const sourceIds = valhallaSourceIds(current.url);
      const { costingOptions, usesCurrentClosures } = buildClosureSafeCostingOptions(options, mode);

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
        ...buildExclusions(options),
      };

      const requestId = randomUUID();
      const startedAt = Date.now();
      if (usesCurrentClosures) body.openmapx_request_id = requestId;
      const data = await client.post<ValhallaResponse>(
        "/optimized_route",
        body,
        15_000,
        "Valhalla optimized_route error",
      );
      const travelMode = mode as TravelMode;
      const trafficProof =
        usesCurrentClosures && !client.hostedByStadia
          ? readTrafficProof(
              data.openmapx_traffic_proof,
              requestId,
              "optimized_route",
              COSTING_MAP[mode],
              startedAt,
            )
          : undefined;

      const routes: Route[] = [transformTrip(data.trip, travelMode, options.units)];
      if (mode === "walking") await refineWalkingRoutes(client, routes, [data.trip], options.lang);

      // Extract optimized order from trip.locations[].original_index
      const optimizedOrder =
        data.trip.locations?.map((loc) => loc.original_index ?? 0) ?? waypoints.map((_, i) => i);

      for (const route of routes) {
        route.sourceIds = sourceIds;
        if (trafficProof) route.trafficProof = trafficProof;
      }
      if (trafficProof) await attachTrafficCoverage(client, routes, trafficProof, costingOptions);

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

      const data = await valhallaClient(http, settings()).post<ValhallaTraceAttributesResponse>(
        "/trace_attributes",
        body,
        15_000,
        "Valhalla trace_attributes error",
      );

      return {
        geometry: data.shape ? decodePolyline(data.shape, 6) : [],
        edges: (data.edges ?? []).map((edge) => transformTraceEdge(edge, data.admins)),
        points: (data.matched_points ?? []).map(transformMatchedPoint),
        mode,
      };
    },

    /**
     * Many-to-many time/distance matrix via Valhalla's `sources_to_targets`
     * endpoint. Used by EV charge-planning to score charger detours without
     * requesting a full route per candidate.
     */
    async getMatrix(
      sources: [number, number][],
      targets: [number, number][],
      opts: { mode?: TravelMode } = {},
    ): Promise<({ seconds: number; km: number } | null)[][]> {
      const costing = COSTING_MAP[opts.mode ?? "driving"] ?? "auto";

      const body = {
        sources: sources.map(([lon, lat]) => ({ lat, lon })),
        targets: targets.map(([lon, lat]) => ({ lat, lon })),
        costing,
        units: "kilometers",
      };

      const data = await valhallaClient(http, settings()).post<ValhallaMatrixResponse>(
        "/sources_to_targets",
        body,
        15_000,
        "Valhalla sources_to_targets error",
      );

      return data.sources_to_targets.map((row) =>
        row.map((cell) =>
          cell.time == null || cell.distance == null
            ? null
            : { seconds: cell.time, km: cell.distance },
        ),
      );
    },
  };
}
