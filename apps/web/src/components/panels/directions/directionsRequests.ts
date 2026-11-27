import {
  type BikeRoutingOptions,
  type DirectionsQueryParams,
  type LngLat,
  type TravelMode,
  timeZoneAt,
  type Waypoint,
} from "@openmapx/core";
import type { RouteArrivalContext } from "@/components/panels/directions/routeArrival";
import { toDateTimeLocalString } from "@/components/panels/directions/TimeModePicker";

/** The ground route request without its waypoints. */
export type GroundRouteRequest = Omit<DirectionsQueryParams, "waypoints">;

/** The coordinates of every placed stop, in order. */
export function placedCoordinates(waypoints: readonly Waypoint[]): LngLat[] {
  return waypoints.flatMap((wp) => (wp.coords ? [wp.coords] : []));
}

/** Whether every stop of a trip of at least two is placed. */
export function tripComplete(waypoints: readonly Waypoint[]): boolean {
  return waypoints.length >= 2 && waypoints.every((wp) => wp.coords !== null);
}

/** Driving and motorcycle honour a departure or arrival time; other ground modes do not. */
export function isTimedGroundMode(mode: TravelMode): boolean {
  return mode === "driving" || mode === "motorcycle";
}

/**
 * The wall-clock departure or arrival a timed ground mode asks for: the trip
 * time as `YYYY-MM-DDTHH:mm`, under the chosen time mode.
 */
export function drivingWallClocks(
  mode: TravelMode,
  timeMode: "now" | "depart" | "arrive",
  tripTime: Date | null,
): { departAt?: string; arriveBy?: string } {
  if (!isTimedGroundMode(mode) || !(tripTime instanceof Date)) return {};
  if (timeMode === "depart") return { departAt: toDateTimeLocalString(tripTime) };
  if (timeMode === "arrive") return { arriveBy: toDateTimeLocalString(tripTime) };
  return {};
}

export interface GroundRequestInput extends BikeRoutingOptions {
  mode: TravelMode;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  avoidClosures: boolean;
  units: "metric" | "imperial";
  lang: string;
  departAt?: string;
  arriveBy?: string;
  provider?: string;
}

/** The displayed route's request without its waypoints; a stop detour compares with exactly this. */
export function buildGroundRequest(input: GroundRequestInput): GroundRouteRequest {
  return {
    mode: input.mode,
    avoidHighways: input.avoidHighways,
    avoidTolls: input.avoidTolls,
    avoidFerries: input.avoidFerries,
    bikeProfile: input.bikeProfile,
    bikeHillPreference: input.bikeHillPreference,
    bikePreferQuietRoads: input.bikePreferQuietRoads,
    bikePreferSmoothSurfaces: input.bikePreferSmoothSurfaces,
    bikeSpeedKmh: input.bikeSpeedKmh,
    avoidClosures: input.avoidClosures,
    units: input.units,
    lang: input.lang,
    departAt: input.departAt,
    arriveBy: input.arriveBy,
    ...(input.provider && { provider: input.provider }),
  };
}

/**
 * How a route card states its arrival: from now, from a departure or as a
 * deadline, each in the zones of the trip's ends. Untimed modes state none.
 */
export function buildArrivalContext(input: {
  mode: TravelMode;
  timeMode: "now" | "depart" | "arrive";
  departAt?: string;
  arriveBy?: string;
  origin: LngLat | null;
  destination: LngLat | null;
}): RouteArrivalContext | undefined {
  if (!isTimedGroundMode(input.mode)) return undefined;
  const destinationTimeZone = input.destination
    ? timeZoneAt(input.destination[1], input.destination[0])
    : null;
  if (input.timeMode === "now") return { kind: "now", destinationTimeZone };
  if (input.departAt)
    return {
      kind: "departAt",
      wallClock: input.departAt,
      originTimeZone: input.origin ? timeZoneAt(input.origin[1], input.origin[0]) : null,
      destinationTimeZone,
    };
  if (input.arriveBy) return { kind: "arriveBy", wallClock: input.arriveBy, destinationTimeZone };
  return undefined;
}
