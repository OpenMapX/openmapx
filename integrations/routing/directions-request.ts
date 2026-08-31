import type { TravelMode } from "@openmapx/core";
import {
  parseWgs84PointList,
  type RouteQuery,
  type RoutingOptions,
  scalarQueries,
} from "@openmapx/integration-framework";
import { round } from "./closure-exclusions.js";
import { parseDateTime, parseTravelMode } from "./validation.js";

export const MAX_ROUTE_WAYPOINTS = 50;

export interface DirectionsRequestPolicy {
  operation: "directions" | "optimize";
  minimumWaypoints: number;
  minimumWaypointsError: string;
  transitModeError: string;
}

export const DIRECTIONS_REQUEST_POLICY: DirectionsRequestPolicy = {
  operation: "directions",
  minimumWaypoints: 2,
  minimumWaypointsError: "At least 2 waypoints are required",
  transitModeError: "Use /api/transit/plan for transit routing",
};

export const OPTIMIZE_DIRECTIONS_REQUEST_POLICY: DirectionsRequestPolicy = {
  operation: "optimize",
  minimumWaypoints: 3,
  minimumWaypointsError: "At least 3 waypoints are required for optimization",
  transitModeError: "transit routing cannot be optimised here",
};

type ParsedRoutingOptions = Required<
  Pick<RoutingOptions, "avoidFerries" | "avoidHighways" | "avoidTolls" | "units" | "useLiveTraffic">
> &
  Pick<RoutingOptions, "arriveBy" | "departAt" | "lang">;

export interface ParsedDirectionsRequest {
  operation: DirectionsRequestPolicy["operation"];
  waypoints: [number, number][];
  travelMode: TravelMode;
  avoidClosures: boolean;
  requireTimeAware: boolean;
  routingOptions: ParsedRoutingOptions;
}

export class DirectionsRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectionsRequestValidationError";
  }
}

function parseWaypointList(raw: string): [number, number][] {
  const candidates = raw.split(";").map((pair) => pair.split(","));
  const points = parseWgs84PointList(candidates, { min: 2, max: MAX_ROUTE_WAYPOINTS });
  if (!points) {
    throw new Error(`Waypoints must contain 2-${MAX_ROUTE_WAYPOINTS} valid WGS84 lng,lat pairs`);
  }
  return points;
}

function parseWaypoints(query: Record<string, string>): [number, number][] {
  if (query.waypoints) return parseWaypointList(query.waypoints);

  if (
    query.originLng !== undefined &&
    query.originLat !== undefined &&
    query.destLng !== undefined &&
    query.destLat !== undefined
  ) {
    const points = parseWgs84PointList(
      [
        [query.originLng, query.originLat],
        [query.destLng, query.destLat],
      ],
      { min: 2, max: 2 },
    );
    if (!points) throw new Error("Origin and destination must be valid WGS84 coordinates");
    return points;
  }

  throw new Error(
    "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
  );
}

function isMotorisedMode(mode: TravelMode): boolean {
  return mode === "driving" || mode === "motorcycle";
}

export function parseDirectionsRequest(
  rawQuery: RouteQuery,
  policy: DirectionsRequestPolicy,
): ParsedDirectionsRequest {
  const query = scalarQueries(rawQuery);

  try {
    const waypoints = parseWaypoints(query);
    if (waypoints.length < policy.minimumWaypoints) {
      throw new Error(policy.minimumWaypointsError);
    }

    const travelMode = parseTravelMode(query.mode);
    const departAt = parseDateTime(query.departAt, "departAt");
    const arriveBy = parseDateTime(query.arriveBy, "arriveBy");
    if (travelMode === "transit") throw new Error(policy.transitModeError);
    if (departAt && arriveBy) {
      throw new Error("departAt and arriveBy are mutually exclusive");
    }

    return {
      operation: policy.operation,
      waypoints,
      travelMode,
      avoidClosures: query.avoidClosures === "true" || query.avoidClosures === "1",
      requireTimeAware: Boolean(departAt || arriveBy),
      routingOptions: {
        avoidHighways: query.avoidHighways === "true",
        avoidTolls: query.avoidTolls === "true",
        avoidFerries: query.avoidFerries === "true",
        units: (query.units ?? "metric") as "metric" | "imperial",
        lang: query.lang,
        departAt,
        arriveBy,
        useLiveTraffic: isMotorisedMode(travelMode),
      },
    };
  } catch (error) {
    throw new DirectionsRequestValidationError((error as Error).message);
  }
}

function roundWaypoints(waypoints: [number, number][]): [number, number][] {
  return waypoints.map((waypoint) => [round(waypoint[0], 4), round(waypoint[1], 4)]);
}

export function createDirectionsCacheIdentity(
  request: ParsedDirectionsRequest,
  exclusionsHash: string | null,
): Record<string, unknown> {
  const { routingOptions } = request;
  return {
    arriveBy: routingOptions.arriveBy ?? null,
    avoidClosures: request.avoidClosures,
    avoidFerries: routingOptions.avoidFerries,
    avoidHighways: routingOptions.avoidHighways,
    avoidTolls: routingOptions.avoidTolls,
    departAt: routingOptions.departAt ?? null,
    exclusionsHash,
    lang: routingOptions.lang ?? "en",
    mode: request.travelMode,
    ...(request.operation === "optimize" ? { optimize: true } : {}),
    units: routingOptions.units,
    waypoints: roundWaypoints(request.waypoints),
  };
}
