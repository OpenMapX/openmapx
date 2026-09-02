import {
  MAX_DWELL_SECONDS,
  resolveScheduleConstraints,
  type ScheduleAnchor,
  type TravelMode,
  type WaypointSchedule,
} from "@openmapx/core";
import { parseWgs84PointList } from "@openmapx/integration-framework";
import { round } from "./closure-exclusions.js";
import type { RoutingOptions } from "./types.js";
import { parseTravelMode } from "./validation.js";

/**
 * The chained path issues one provider call per leg, so this cap is a latency
 * ceiling rather than a modelling limit. It is deliberately lower than
 * `MAX_ROUTE_WAYPOINTS` (50) used by the unconstrained `/directions` route.
 */
export const MAX_SCHEDULE_WAYPOINTS = 25;

const SCHEDULE_FIELDS = new Set(["departAfter", "arriveBy", "fixedAt", "dwellSeconds", "timeZone"]);

export class ScheduleRequestValidationError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ScheduleRequestValidationError";
  }
}

export interface ParsedScheduleRequest {
  waypoints: [number, number][];
  schedules: (WaypointSchedule | null)[];
  travelMode: TravelMode;
  anchor: ScheduleAnchor;
  /** Any waypoint carries `departAfter`, `arriveBy` or `fixedAt`. */
  hasWindows: boolean;
  optimize: boolean;
  avoidClosures: boolean;
  routingOptions: RoutingOptions;
}

function fail(message: string, reason?: string): never {
  throw new ScheduleRequestValidationError(message, reason);
}

function parseWaypointSchedule(raw: unknown, index: number): WaypointSchedule | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`schedules[${index}] must be an object or null`);
  }
  const schedule: WaypointSchedule = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCHEDULE_FIELDS.has(key)) fail(`unknown schedule field "${key}" at index ${index}`);
    if (value === undefined || value === null) continue;
    if (key === "dwellSeconds") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        fail(`schedules[${index}].dwellSeconds must be an integer number of seconds`);
      }
      if (value < 0 || value > MAX_DWELL_SECONDS) {
        fail(`schedules[${index}].dwellSeconds must be between 0 and ${MAX_DWELL_SECONDS}`);
      }
      schedule.dwellSeconds = value;
      continue;
    }
    if (typeof value !== "string") fail(`schedules[${index}].${key} must be a string`);
    schedule[key as "departAfter" | "arriveBy" | "fixedAt" | "timeZone"] = value;
  }
  return Object.keys(schedule).length > 0 ? schedule : null;
}

export function parseScheduleRequest(body: unknown): ParsedScheduleRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  const waypoints = parseWgs84PointList(raw.waypoints, {
    min: 2,
    max: MAX_SCHEDULE_WAYPOINTS,
  });
  if (!waypoints) {
    fail(`Waypoints must contain 2-${MAX_SCHEDULE_WAYPOINTS} valid WGS84 [lng, lat] pairs`);
  }

  let schedules: (WaypointSchedule | null)[] = waypoints.map(() => null);
  if (raw.schedules !== undefined) {
    if (!Array.isArray(raw.schedules) || raw.schedules.length !== waypoints.length) {
      fail("schedules must have one entry per waypoint");
    }
    schedules = raw.schedules.map(parseWaypointSchedule);
  }

  const travelMode = parseTravelMode(typeof raw.mode === "string" ? raw.mode : undefined);
  if (travelMode === "transit") fail("Use /api/transit/plan/chain for scheduled transit trips");

  const departAt = typeof raw.departAt === "string" ? raw.departAt : undefined;
  const arriveBy = typeof raw.arriveBy === "string" ? raw.arriveBy : undefined;
  if (departAt && arriveBy) fail("departAt and arriveBy are mutually exclusive");
  const anchor: ScheduleAnchor = arriveBy
    ? { kind: "arriveBy", wallClock: arriveBy }
    : departAt
      ? { kind: "departAt", wallClock: departAt }
      : { kind: "now" };

  const hasWindows = schedules.some(
    (schedule) =>
      schedule !== null &&
      (schedule.departAfter !== undefined ||
        schedule.arriveBy !== undefined ||
        schedule.fixedAt !== undefined),
  );

  const optimize = raw.optimize === true;
  if (optimize && hasWindows) {
    fail(
      "Stop order cannot be optimized while a waypoint has an appointment or time window",
      "window-constraints-not-optimizable",
    );
  }

  const motorised = travelMode === "driving" || travelMode === "motorcycle";
  return {
    waypoints,
    schedules,
    travelMode,
    anchor,
    hasWindows,
    optimize,
    avoidClosures: raw.avoidClosures === true || raw.avoidClosures === "1",
    routingOptions: {
      avoidHighways: raw.avoidHighways === true,
      avoidTolls: raw.avoidTolls === true,
      avoidFerries: raw.avoidFerries === true,
      units: raw.units === "imperial" ? "imperial" : "metric",
      ...(typeof raw.lang === "string" ? { lang: raw.lang } : {}),
      useLiveTraffic: motorised,
    },
  };
}

/**
 * Identity for the response cache. Every temporal input is included **after**
 * zone resolution, so two requests that name the same wall clock in different
 * zones can never share an entry.
 *
 * `nowMs: 0` keeps the identity independent of the clock. Only `anchorMs`
 * depends on it, and the identity carries the anchor itself rather than the
 * resolved instant, so nothing is lost.
 */
export function createScheduleCacheIdentity(
  request: ParsedScheduleRequest,
  exclusionsHash: string | null,
): Record<string, unknown> {
  const resolved = resolveScheduleConstraints({
    waypoints: request.waypoints.map((coords, index) => ({
      coords,
      schedule: request.schedules[index] ?? undefined,
    })),
    anchor: request.anchor,
    nowMs: 0,
  });

  return {
    anchor: request.anchor,
    avoidClosures: request.avoidClosures,
    avoidFerries: request.routingOptions.avoidFerries,
    avoidHighways: request.routingOptions.avoidHighways,
    avoidTolls: request.routingOptions.avoidTolls,
    direction: resolved.direction,
    exclusionsHash,
    lang: request.routingOptions.lang ?? "en",
    mode: request.travelMode,
    optimize: request.optimize,
    stops: resolved.stops.map((stop) => ({
      dwellSeconds: stop.dwellSeconds,
      earliestDepartureMs: stop.earliestDepartureMs,
      latestArrivalMs: stop.latestArrivalMs,
      timeZone: stop.timeZone,
    })),
    units: request.routingOptions.units,
    waypoints: request.waypoints.map((wp) => [round(wp[0], 4), round(wp[1], 4)]),
  };
}
