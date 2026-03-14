/**
 * Valhalla multi-modal routing service client (walking, cycling).
 * Default: public FOSSGIS Valhalla instance. Override with VALHALLA_URL env var.
 */

import type { DirectionsResult, Route, RouteStep, TravelMode } from "@openmapx/core";
import { decodePolyline } from "../utils/polyline.js";

const VALHALLA_URL = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";

const COSTING_MAP: Record<string, string> = {
  walking: "pedestrian",
  cycling: "bicycle",
};

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
}

interface ValhallaTrip {
  summary: { length: number; time: number };
  legs: ValhallaLeg[];
}

interface ValhallaResponse {
  trip: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
}

function transformTrip(trip: ValhallaTrip, mode: TravelMode): Route {
  const allCoords = trip.legs.flatMap((leg) => decodePolyline(leg.shape, 6));

  const steps: RouteStep[] = trip.legs.flatMap((leg) => {
    const coords = decodePolyline(leg.shape, 6);
    return leg.maneuvers.map((m) => ({
      instruction: m.instruction,
      distance: m.length * 1000, // km → metres
      duration: m.time,
      coordinates: coords.slice(m.begin_shape_index, m.end_shape_index + 1),
    }));
  });

  // Build "via [primary road]" from first leg's first named maneuver
  const firstNamed = trip.legs[0]?.maneuvers.find(
    (m) => m.street_names && m.street_names.length > 0,
  );
  const summary = firstNamed?.street_names?.[0] ? `via ${firstNamed.street_names[0]}` : undefined;

  return {
    distance: trip.summary.length * 1000, // km → metres
    duration: trip.summary.time,
    geometry: allCoords,
    steps,
    mode,
    summary,
  };
}

export interface ValhallaRouteOptions {
  avoidHighways?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
}

export const valhallaService = {
  async route(
    origin: [number, number],
    destination: [number, number],
    mode: "walking" | "cycling",
    options: ValhallaRouteOptions = {},
  ): Promise<DirectionsResult> {
    const costingOptions: Record<string, unknown> = {};
    if (options.avoidHighways) costingOptions.use_highways = 0;
    if (options.avoidFerries) costingOptions.use_ferry = 0;

    const body: Record<string, unknown> = {
      locations: [
        { lon: origin[0], lat: origin[1] },
        { lon: destination[0], lat: destination[1] },
      ],
      costing: COSTING_MAP[mode],
      costing_options: { [COSTING_MAP[mode]]: costingOptions },
      directions_options: { units: options.units === "imperial" ? "miles" : "km" },
      alternates: 3,
    };

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
      origin,
      destination,
      routes,
      activeRouteIndex: 0,
    };
  },
};
