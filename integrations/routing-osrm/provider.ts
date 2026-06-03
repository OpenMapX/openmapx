/**
 * OSRM routing service client (car routing).
 * Default: public OSRM demo server. Override with OSRM_URL env var.
 */

import type { DirectionsResult, Route, RouteLeg, RouteStep, TravelMode } from "@openmapx/core";
import { USER_AGENT } from "@openmapx/core";
import type {
  ManeuverLane,
  RoutingOptions,
  RoutingProvider,
} from "@openmapx/integration-routing/types";

// Populated by setup(ctx): service-registry URL → ctx.config.endpoint (which
// already folds in `INTEGRATION_ROUTING_OSRM_ENDPOINT` + legacy `OSRM_URL`
// env aliases via the core config resolver) → hardcoded fallback.
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
}

interface OsrmIntersection {
  lanes?: OsrmLane[];
}

interface OsrmAnnotation {
  maxspeed?: { speed?: number; unit?: string; unknown?: boolean }[];
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
}

interface OsrmLeg {
  summary: string;
  distance: number;
  duration: number;
  steps: OsrmStep[];
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
  return withLanes.lanes.map((l) => ({
    indications: l.indications ?? [],
    valid: Boolean(l.valid),
  }));
}

/** First known maxspeed annotation, normalized to km/h. */
function osrmSpeedLimit(step: OsrmStep): number | undefined {
  const entry = step.annotation?.maxspeed?.find((m) => typeof m.speed === "number" && !m.unknown);
  if (!entry || typeof entry.speed !== "number") return undefined;
  if (entry.unit === "mph") return Math.round(entry.speed * 1.609);
  return entry.speed; // km/h
}

/**
 * Map a raw OSRM step to the unified RouteStep, carrying the normalized
 * maneuver, lane guidance, and speed limit when present. Exported for testing.
 */
export function transformOsrmStep(step: OsrmStep): RouteStep {
  return {
    instruction: generateInstruction(step.maneuver, step.name, step.ref),
    distance: step.distance,
    duration: step.duration,
    coordinates: step.geometry.coordinates,
    maneuver: { type: step.maneuver.type, modifier: step.maneuver.modifier },
    lanes: osrmLanes(step),
    speedLimit: osrmSpeedLimit(step),
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

  return {
    distance: r.distance,
    duration: r.duration,
    geometry: r.geometry.coordinates,
    legs,
    steps,
    mode,
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

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`OSRM error ${res.status}`);

    const data = (await res.json()) as OsrmResponse;
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

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`OSRM trip error ${res.status}`);

    const data = (await res.json()) as OsrmTripResponse;
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
