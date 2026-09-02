import { MAX_DWELL_SECONDS, type ScheduleAnchor, type WaypointSchedule } from "@openmapx/core";
import type { TripPlanRequest } from "@openmapx/integration-framework";

/**
 * A chain issues one planner call per segment, so this cap bounds latency
 * rather than the model. Seven sequential MOTIS round trips is already a long
 * wait; more than that belongs to a different feature.
 */
export const MAX_CHAIN_WAYPOINTS = 8;

const SCHEDULE_FIELDS = new Set(["departAfter", "arriveBy", "fixedAt", "dwellSeconds", "timeZone"]);
const TRANSFER_BUFFERS = new Set(["standard", "relaxed", "extra"]);
const BIKE_HILL_PREFERENCES = new Set(["default", "avoid", "strongly-avoid"]);

export class ChainRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainRequestValidationError";
  }
}

export interface ParsedChainRequest {
  waypoints: { lat: number; lng: number }[];
  schedules: (WaypointSchedule | null)[];
  anchor: ScheduleAnchor;
  numItineraries?: number;
  baseRequest: Omit<TripPlanRequest, "from" | "to" | "departureTime" | "arrivalTime">;
}

function fail(message: string): never {
  throw new ChainRequestValidationError(message);
}

function parseWaypoint(value: unknown, index: number): { lat: number; lng: number } {
  if (typeof value !== "object" || value === null) fail(`waypoints[${index}] must be an object`);
  const { lat, lng } = value as Record<string, unknown>;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    fail(`waypoints[${index}] has an invalid coordinate`);
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    fail(`waypoints[${index}] has an invalid coordinate`);
  }
  return { lat, lng };
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
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_DWELL_SECONDS
      ) {
        fail(
          `schedules[${index}].dwellSeconds must be an integer between 0 and ${MAX_DWELL_SECONDS}`,
        );
      }
      schedule.dwellSeconds = value;
      continue;
    }
    if (typeof value !== "string") fail(`schedules[${index}].${key} must be a string`);
    schedule[key as "departAfter" | "arriveBy" | "fixedAt" | "timeZone"] = value;
  }
  return Object.keys(schedule).length > 0 ? schedule : null;
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${name} must be an array of strings`);
  }
  return value as string[];
}

export function parseChainRequest(body: unknown): ParsedChainRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(raw.waypoints)) fail("waypoints must be an array");
  if (raw.waypoints.length < 2 || raw.waypoints.length > MAX_CHAIN_WAYPOINTS) {
    fail(`waypoints must contain 2-${MAX_CHAIN_WAYPOINTS} points`);
  }
  const waypoints = raw.waypoints.map(parseWaypoint);

  let schedules: (WaypointSchedule | null)[] = waypoints.map(() => null);
  if (raw.schedules !== undefined) {
    if (!Array.isArray(raw.schedules) || raw.schedules.length !== waypoints.length) {
      fail("schedules must have one entry per waypoint");
    }
    schedules = raw.schedules.map(parseWaypointSchedule);
  }

  const departureTime = typeof raw.departureTime === "string" ? raw.departureTime : undefined;
  const arrivalTime = typeof raw.arrivalTime === "string" ? raw.arrivalTime : undefined;
  if (departureTime && arrivalTime) fail("departureTime and arrivalTime are mutually exclusive");
  const anchor: ScheduleAnchor = arrivalTime
    ? { kind: "arriveBy", wallClock: arrivalTime }
    : departureTime
      ? { kind: "departAt", wallClock: departureTime }
      : { kind: "now" };

  // A chain has no single cursor to page through; each segment has its own
  // alternatives instead.
  if (raw.page_token !== undefined || raw.pageCursor !== undefined) {
    fail("paging is not supported for a chained plan");
  }

  const transferBuffer = raw.transferBuffer;
  if (transferBuffer !== undefined && !TRANSFER_BUFFERS.has(String(transferBuffer))) {
    fail("transferBuffer must be standard, relaxed, or extra");
  }
  const bikeHillPreference = raw.bikeHillPreference;
  if (bikeHillPreference !== undefined && !BIKE_HILL_PREFERENCES.has(String(bikeHillPreference))) {
    fail("invalid bikeHillPreference");
  }
  const maxTransfers = raw.maxTransfers;
  if (
    maxTransfers !== undefined &&
    (!Number.isInteger(maxTransfers) ||
      (maxTransfers as number) < 0 ||
      (maxTransfers as number) > 8)
  ) {
    fail("maxTransfers must be an integer from 0 to 8");
  }
  const numItinerariesRaw = raw.numItineraries;
  const numItineraries =
    typeof numItinerariesRaw === "number" && Number.isFinite(numItinerariesRaw)
      ? Math.min(Math.max(1, Math.floor(numItinerariesRaw)), 10)
      : undefined;

  const wheelchair = raw.wheelchair === true || raw.wheelchairRequired === true;

  return {
    waypoints,
    schedules,
    anchor,
    ...(numItineraries !== undefined ? { numItineraries } : {}),
    baseRequest: {
      modes: stringArray(raw.modes, "modes") ?? ["TRANSIT"],
      wheelchair,
      wheelchairRequired: wheelchair,
      ...(maxTransfers !== undefined ? { maxTransfers: maxTransfers as number } : {}),
      transferBuffer: (transferBuffer ?? "standard") as "standard" | "relaxed" | "extra",
      requireBikeTransport: raw.requireBikeTransport === true,
      bikeHillPreference: (bikeHillPreference ?? "default") as
        | "default"
        | "avoid"
        | "strongly-avoid",
      ...(typeof raw.capabilityEpoch === "string" ? { capabilityEpoch: raw.capabilityEpoch } : {}),
      preTransitModes: stringArray(raw.preTransitModes, "preTransitModes"),
      postTransitModes: stringArray(raw.postTransitModes, "postTransitModes"),
      directModes: stringArray(raw.directModes, "directModes"),
      deutschlandticketOnly: raw.deutschlandticketOnly === true,
    },
  };
}
