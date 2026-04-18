/**
 * Valhalla multi-modal routing service client (walking, cycling).
 * Default: public FOSSGIS Valhalla instance. Override with VALHALLA_URL env var.
 */

import type { DirectionsResult, Route, RouteLeg, RouteStep, TravelMode } from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";
import type { RoutingOptions, RoutingProvider } from "../routing/types.js";

let VALHALLA_URL = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";

/** Update the Valhalla base URL (called from setup() when service registry resolves it). */
export function setValhallaUrl(url: string): void {
  VALHALLA_URL = url;
}

const COSTING_MAP: Record<string, string> = {
  driving: "auto",
  walking: "pedestrian",
  cycling: "bicycle",
};

const ELEVATION_INTERVAL = 30; // metres between elevation samples

interface ValhallaManeuver {
  type: number;
  instruction: string;
  length: number; // km
  time: number; // seconds
  begin_shape_index: number;
  end_shape_index: number;
  street_names?: string[];
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

function transformLeg(leg: ValhallaLeg): RouteLeg {
  const coords = decodePolyline(leg.shape, 6);
  const steps: RouteStep[] = leg.maneuvers.map((m) => ({
    instruction: m.instruction,
    distance: m.length * 1000, // km -> metres
    duration: m.time,
    coordinates: coords.slice(m.begin_shape_index, m.end_shape_index + 1),
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

export const valhallaService: RoutingProvider = {
  id: "valhalla",
  supportedModes: ["walking", "cycling", "driving"] as TravelMode[],

  async getRoute(
    waypoints: [number, number][],
    mode: TravelMode,
    options: RoutingOptions = {},
  ): Promise<DirectionsResult> {
    const costingOptions: Record<string, unknown> = {};
    if (options.avoidHighways) costingOptions.use_highways = 0;
    if (options.avoidFerries) costingOptions.use_ferry = 0;

    const locations = waypoints.map((wp) => ({ lon: wp[0], lat: wp[1], type: "break" as const }));

    const body: Record<string, unknown> = {
      locations,
      costing: COSTING_MAP[mode],
      costing_options: { [COSTING_MAP[mode]]: costingOptions },
      directions_options: {
        units: options.units === "imperial" ? "miles" : "km",
        language: options.lang ?? "en",
      },
      elevation_interval: ELEVATION_INTERVAL,
    };

    // Valhalla only supports alternates with exactly 2 waypoints
    if (waypoints.length === 2) {
      body.alternates = 3;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Valhalla error ${res.status}`);

    const data = (await res.json()) as ValhallaResponse;
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
    const costingOptions: Record<string, unknown> = {};
    if (options.avoidHighways) costingOptions.use_highways = 0;
    if (options.avoidFerries) costingOptions.use_ferry = 0;

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
      elevation_interval: ELEVATION_INTERVAL,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${VALHALLA_URL}/optimized_route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Valhalla optimized_route error ${res.status}`);

    const data = (await res.json()) as ValhallaResponse;
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
};
