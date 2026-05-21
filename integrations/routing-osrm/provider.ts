/**
 * OSRM routing service client (car routing).
 * Default: public OSRM demo server. Override with OSRM_URL env var.
 */

import type { DirectionsResult, Route, RouteLeg, RouteStep, TravelMode } from "@openmapx/core";
import { USER_AGENT } from "@openmapx/core";
import type { RoutingOptions, RoutingProvider } from "@openmapx/integration-routing/types";

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

interface OsrmStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  maneuver: OsrmManeuver;
  geometry: { type: "LineString"; coordinates: [number, number][] };
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

function transformLeg(leg: OsrmLeg): RouteLeg {
  const steps: RouteStep[] = leg.steps.map((step) => ({
    instruction: generateInstruction(step.maneuver, step.name, step.ref),
    distance: step.distance,
    duration: step.duration,
    coordinates: step.geometry.coordinates,
  }));

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
