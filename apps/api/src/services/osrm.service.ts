/**
 * OSRM routing service client (car routing, Phase 5).
 * Default: public OSRM demo server. Override with OSRM_URL env var.
 */

import type { DirectionsResult, Route, RouteStep, TravelMode } from "@openmapx/core";

const OSRM_URL = process.env.OSRM_URL ?? "https://router.project-osrm.org";

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

function transformRoute(r: OsrmRoute, mode: TravelMode): Route {
  const steps: RouteStep[] = r.legs.flatMap((leg) =>
    leg.steps.map((step) => ({
      instruction: generateInstruction(step.maneuver, step.name, step.ref),
      distance: step.distance,
      duration: step.duration,
      coordinates: step.geometry.coordinates,
    })),
  );

  const legSummary = r.legs[0]?.summary ?? "";
  const summary = legSummary ? `via ${legSummary}` : undefined;

  return {
    distance: r.distance,
    duration: r.duration,
    geometry: r.geometry.coordinates,
    steps,
    mode,
    summary,
  };
}

export interface OsrmRouteOptions {
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
}

export const osrmService = {
  async route(
    origin: [number, number],
    destination: [number, number],
    options: OsrmRouteOptions = {},
  ): Promise<DirectionsResult> {
    const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;

    const exclude: string[] = [];
    if (options.avoidHighways) exclude.push("motorway");
    if (options.avoidTolls) exclude.push("toll");
    if (options.avoidFerries) exclude.push("ferry");

    const url = new URL(`${OSRM_URL}/route/v1/driving/${coords}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "true");
    url.searchParams.set("alternatives", "3");
    if (exclude.length > 0) url.searchParams.set("exclude", exclude.join(","));

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "OpenMapX/1.0" },
    });
    if (!res.ok) throw new Error(`OSRM error ${res.status}`);

    const data = (await res.json()) as OsrmResponse;
    if (data.code !== "Ok" || data.routes.length === 0) {
      throw new Error("OSRM returned no routes");
    }

    return {
      origin,
      destination,
      routes: data.routes.map((r) => transformRoute(r, "driving")),
      activeRouteIndex: 0,
    };
  },
};
