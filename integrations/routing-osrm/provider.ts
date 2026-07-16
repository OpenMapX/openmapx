/**
 * OSRM routing service client (car routing).
 * Default: public OSRM demo server. Override via the self-hosted `osrm` service
 * capability or INTEGRATION_ROUTING_OSRM_ENDPOINT.
 */

import type { DirectionsResult, Route, RouteLeg, RouteStep, TravelMode } from "@openmapx/core";
import { fetchJson } from "@openmapx/core";
import type {
  ManeuverLane,
  RoutingOptions,
  RoutingProvider,
} from "@openmapx/integration-routing/types";

// Populated by setup(ctx): service-registry URL → ctx.config.endpoint
// (INTEGRATION_ROUTING_OSRM_ENDPOINT) → hardcoded fallback.
let OSRM_URL = "https://router.project-osrm.org";

/** Update the OSRM base URL (called from setup() when service registry resolves it). */
export function setOsrmUrl(url: string): void {
  OSRM_URL = url;
}

interface OsrmManeuver {
  type: string;
  modifier?: string;
  location: [number, number];
  exit?: number;
}

interface OsrmLane {
  valid?: boolean;
  indications?: string[];
  /** The specific indication to follow when this lane is valid (OSRM ≥ 5.x). */
  valid_indication?: string;
}

interface OsrmIntersection {
  lanes?: OsrmLane[];
}

interface OsrmMaxspeed {
  speed?: number;
  unit?: string;
  unknown?: boolean;
}

interface OsrmAnnotation {
  maxspeed?: OsrmMaxspeed[];
}

interface OsrmStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  maneuver: OsrmManeuver;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  intersections?: OsrmIntersection[];
  annotation?: OsrmAnnotation;
  driving_side?: "left" | "right";
}

interface OsrmLeg {
  summary: string;
  distance: number;
  duration: number;
  steps: OsrmStep[];
  // Standard OSRM attaches the `annotations=maxspeed` data to the LEG (one entry
  // per overview-geometry segment), not to individual steps.
  annotation?: OsrmAnnotation;
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  legs: OsrmLeg[];
}

interface OsrmResponse {
  code: string;
  routes: OsrmRoute[];
}

interface OsrmTripWaypoint {
  waypoint_index: number;
  trips_index: number;
  location: [number, number];
}

interface OsrmTripResponse {
  code: string;
  trips: OsrmRoute[];
  waypoints: OsrmTripWaypoint[];
}

function generateInstruction(maneuver: OsrmManeuver, name: string, ref?: string): string {
  const road = [name, ref ? `(${ref})` : ""].filter(Boolean).join(" ").trim() || "the road";
  switch (maneuver.type) {
    case "depart":
      return `Head onto ${road}`;
    case "arrive":
      return "Arrive at your destination";
    case "turn":
      return `Turn ${maneuver.modifier ?? "straight"} onto ${road}`;
    case "merge":
      return `Merge onto ${road}`;
    case "on ramp":
      return `Take the ramp onto ${road}`;
    case "off ramp":
      return `Take exit onto ${road}`;
    case "fork":
      return `Keep ${maneuver.modifier ?? "straight"} at the fork onto ${road}`;
    case "roundabout":
    case "rotary": {
      const exit = maneuver.exit ? `exit ${maneuver.exit}` : "the exit";
      return `At the roundabout, take ${exit} onto ${road}`;
    }
    case "end of road":
      return `At the end of the road, turn ${maneuver.modifier ?? "right"} onto ${road}`;
    default:
      return name ? `Continue onto ${road}` : "Continue straight";
  }
}

/** Lane guidance from the first intersection that carries lanes, if any. */
function osrmLanes(step: OsrmStep): ManeuverLane[] | undefined {
  const withLanes = step.intersections?.find((i) => i.lanes && i.lanes.length > 0);
  if (!withLanes?.lanes) return undefined;
  return withLanes.lanes.map((l) => {
    const lane: ManeuverLane = {
      indications: l.indications ?? [],
      valid: Boolean(l.valid),
    };
    if (l.valid_indication) lane.active = l.valid_indication;
    return lane;
  });
}

/** Normalize one OSRM maxspeed entry to km/h, or null when unknown/absent. */
function normalizeMaxspeed(entry: OsrmMaxspeed | undefined): number | null {
  if (!entry || entry.unknown || typeof entry.speed !== "number") return null;
  return entry.unit === "mph" ? Math.round(entry.speed * 1.609) : entry.speed;
}

/** First known maxspeed annotation, normalized to km/h. */
function osrmSpeedLimit(step: OsrmStep): number | undefined {
  const entry = step.annotation?.maxspeed?.find((m) => typeof m.speed === "number" && !m.unknown);
  if (!entry || typeof entry.speed !== "number") return undefined;
  if (entry.unit === "mph") return Math.round(entry.speed * 1.609);
  return entry.speed; // km/h
}

/**
 * Posted speed limit (km/h) for each geometry segment of a step, aligned to the
 * step's `geometry.length - 1` segments. OSRM's `maxspeed` annotation is already
 * per-segment, so this normalizes each entry (mph→km/h, unknown→null) and pads
 * with null if the annotation is shorter than the segment count.
 */
export function osrmSegmentSpeedLimits(step: OsrmStep): (number | null)[] {
  const segments = Math.max(0, step.geometry.coordinates.length - 1);
  const maxspeed = step.annotation?.maxspeed;
  return Array.from({ length: segments }, (_, i) => normalizeMaxspeed(maxspeed?.[i]));
}

/** Normalize a maxspeed annotation array (mph→km/h, unknown→null) per segment. */
function normalizeMaxspeedArray(maxspeed: OsrmMaxspeed[] | undefined): (number | null)[] {
  return (maxspeed ?? []).map(normalizeMaxspeed);
}

/**
 * Per-segment speed limits for a whole OSRM route, aligned to the overview
 * geometry (`coords - 1`). Reads the leg-level `annotation.maxspeed` (where
 * standard OSRM puts it) first, falling back to per-step annotation for servers
 * that attach it to steps. Returns undefined when neither is present or the
 * lengths don't line up (then navigation uses the per-step `speedLimit` or the
 * live map-match instead). Exported for testing.
 */
export function osrmRouteSegmentSpeedLimits(r: OsrmRoute): (number | null)[] | undefined {
  const expectedLen = r.geometry.coordinates.length - 1;
  return (
    joinSegmentSpeedLimits(
      r.legs.map((leg) => normalizeMaxspeedArray(leg.annotation?.maxspeed)),
      expectedLen,
    ) ??
    joinSegmentSpeedLimits(
      r.legs.flatMap((leg) => leg.steps).map(osrmSegmentSpeedLimits),
      expectedLen,
    )
  );
}

/**
 * Concatenate per-step segment-limit arrays into one route-aligned array. The
 * concatenation is the route's per-segment limit because consecutive OSRM steps
 * share a boundary coordinate but not a segment, so each step contributes
 * exactly `coords - 1` segments and the total equals the overview geometry's
 * segment count. Returns undefined when the total doesn't match `expectedLen`
 * (the overview diverged — fall back to per-step `speedLimit`) or when every
 * segment is unknown (a useless all-null array).
 */
export function joinSegmentSpeedLimits(
  perStep: (number | null)[][],
  expectedLen: number,
): (number | null)[] | undefined {
  const flat = perStep.flat();
  if (flat.length !== expectedLen) return undefined;
  if (flat.every((v) => v === null)) return undefined;
  return flat;
}

/**
 * Map a raw OSRM step to the unified RouteStep, carrying the normalized
 * maneuver, lane guidance, and speed limit when present. Exported for testing.
 */
export function transformOsrmStep(step: OsrmStep): RouteStep {
  const roadNames = [step.name, ...(step.ref?.split(/[/,;]/) ?? [])]
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    instruction: generateInstruction(step.maneuver, step.name, step.ref),
    distance: step.distance,
    duration: step.duration,
    coordinates: step.geometry.coordinates,
    roadNames: roadNames.length > 0 ? [...new Set(roadNames)] : undefined,
    maneuver: { type: step.maneuver.type, modifier: step.maneuver.modifier },
    lanes: osrmLanes(step),
    speedLimit: osrmSpeedLimit(step),
    drivingSide: step.driving_side,
  };
}

function transformLeg(leg: OsrmLeg): RouteLeg {
  const steps: RouteStep[] = leg.steps.map(transformOsrmStep);

  const geometry: [number, number][] = leg.steps.flatMap((step) => step.geometry.coordinates);
  const summary = leg.summary ? `via ${leg.summary}` : undefined;

  return {
    distance: leg.distance,
    duration: leg.duration,
    geometry,
    steps,
    summary,
  };
}

function transformRoute(r: OsrmRoute, mode: TravelMode): Route {
  const legs = r.legs.map(transformLeg);

  const steps: RouteStep[] = legs.flatMap((leg) => leg.steps);

  const legSummary = r.legs[0]?.summary ?? "";
  const summary = legSummary ? `via ${legSummary}` : undefined;

  // Per-segment limits aligned to the overview geometry (leg annotation, with a
  // per-step fallback). Lets navigation read the limit for the exact segment the
  // user is on instead of one stale value per (often long) step.
  const segmentSpeedLimits = osrmRouteSegmentSpeedLimits(r);

  return {
    distance: r.distance,
    duration: r.duration,
    geometry: r.geometry.coordinates,
    legs,
    steps,
    mode,
    segmentSpeedLimits,
    summary,
  };
}

export const osrmService: RoutingProvider = {
  id: "osrm",
  supportedModes: ["driving"] as TravelMode[],

  async getRoute(
    waypoints: [number, number][],
    _mode: TravelMode,
    options: RoutingOptions = {},
  ): Promise<DirectionsResult> {
    const coords = waypoints.map((wp) => `${wp[0]},${wp[1]}`).join(";");

    const exclude: string[] = [];
    if (options.avoidHighways) exclude.push("motorway");
    if (options.avoidTolls) exclude.push("toll");
    if (options.avoidFerries) exclude.push("ferry");

    const url = new URL(`${OSRM_URL}/route/v1/driving/${coords}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "true");
    url.searchParams.set("annotations", "maxspeed");
    // OSRM only supports alternatives with exactly 2 waypoints
    if (waypoints.length === 2) {
      url.searchParams.set("alternatives", "3");
    }
    if (exclude.length > 0) url.searchParams.set("exclude", exclude.join(","));

    const data = await fetchJson<OsrmResponse>(url.toString(), {
      errorMessage: ({ status }) => `OSRM error ${status}`,
    });
    if (data.code !== "Ok" || data.routes.length === 0) {
      throw new Error("OSRM returned no routes");
    }

    return {
      waypoints,
      routes: data.routes.map((r) => transformRoute(r, "driving")),
      activeRouteIndex: 0,
    };
  },

  async optimizeRoute(
    waypoints: [number, number][],
    _mode: TravelMode,
    options: RoutingOptions = {},
  ): Promise<DirectionsResult> {
    const coords = waypoints.map((wp) => `${wp[0]},${wp[1]}`).join(";");

    const exclude: string[] = [];
    if (options.avoidHighways) exclude.push("motorway");
    if (options.avoidTolls) exclude.push("toll");
    if (options.avoidFerries) exclude.push("ferry");

    const url = new URL(`${OSRM_URL}/trip/v1/driving/${coords}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "true");
    url.searchParams.set("annotations", "maxspeed");
    url.searchParams.set("source", "first");
    url.searchParams.set("destination", "last");
    url.searchParams.set("roundtrip", "false");
    if (exclude.length > 0) url.searchParams.set("exclude", exclude.join(","));

    const data = await fetchJson<OsrmTripResponse>(url.toString(), {
      errorMessage: ({ status }) => `OSRM trip error ${status}`,
    });
    if (data.code !== "Ok" || data.trips.length === 0) {
      throw new Error("OSRM returned no trips");
    }

    // Extract optimized waypoint order from the trip response
    const optimizedOrder = data.waypoints.map((wp) => wp.waypoint_index);

    return {
      waypoints,
      routes: data.trips.map((r) => transformRoute(r, "driving")),
      activeRouteIndex: 0,
      optimizedOrder,
    };
  },
};
