import { createHash, randomBytes } from "node:crypto";
import { type BikeRoutingOptions, validBikeRoutingOptions } from "@openmapx/core";
import {
  MAX_EXPIRES_IN_DAYS,
  MAX_SHARE_LABEL_LENGTH as MAX_LABEL_LENGTH,
  MAX_SHARES_PER_USER,
  MAX_SNAPSHOT_PLACES,
  MAX_SHARE_WAYPOINTS as MAX_WAYPOINTS,
  type OwnerShare,
  type PublicListShare,
  type PublicRouteShare,
  type RouteSharePayload,
  type RouteShareWaypoint,
  SHARE_TOKEN_PATTERN,
  type ShareWaypointSchedule,
  type StoredListSnapshot,
  sharingListSnapshotSchema,
  sharingOwnerSchema,
} from "@openmapx/core/api-contracts";
import {
  parseSavedPlaceContributors,
  type SavedPlaceFieldContributors,
} from "@openmapx/core/saved-place-contributors";
import type { ExportPlace } from "@openmapx/core/saved-place-export";

export type {
  OwnerShare,
  PublicListShare,
  PublicRouteShare,
  RouteSharePayload,
  RouteShareWaypoint,
  ShareWaypointSchedule,
  StoredListSnapshot,
};
export { MAX_EXPIRES_IN_DAYS, MAX_SHARES_PER_USER, MAX_SNAPSHOT_PLACES, SHARE_TOKEN_PATTERN };
export type ShareMode = "live" | "snapshot";
export type ShareTargetType = "list" | "route";
const ROUTE_SHARE_MODES = ["driving", "walking", "cycling", "motorcycle"] as const;
export type RouteShareMode = (typeof ROUTE_SHARE_MODES)[number];

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the raw token, base64url. The raw token is never persisted. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function isExpired(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
}

const SHARE_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_SHARE_DWELL_SECONDS = 86_400;

/**
 * `undefined` means "reject the whole payload"; `null` means "this waypoint is
 * unconstrained". A malformed schedule is never trimmed away — a share link
 * that silently dropped an appointment would be worse than no link.
 */
function validSchedule(value: unknown): ShareWaypointSchedule | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const known = new Set(["departAfter", "arriveBy", "fixedAt", "dwellSeconds", "timeZone"]);
  if (Object.keys(source).some((key) => !known.has(key))) return undefined;

  const schedule: ShareWaypointSchedule = {};
  for (const field of ["departAfter", "arriveBy", "fixedAt"] as const) {
    const raw = source[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !SHARE_WALL_CLOCK.test(raw)) return undefined;
    schedule[field] = raw;
  }
  if (source.timeZone !== undefined) {
    if (typeof source.timeZone !== "string") return undefined;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: source.timeZone });
    } catch {
      return undefined;
    }
    schedule.timeZone = source.timeZone;
  }
  if (source.dwellSeconds !== undefined) {
    const dwell = source.dwellSeconds;
    if (
      typeof dwell !== "number" ||
      !Number.isInteger(dwell) ||
      dwell < 0 ||
      dwell > MAX_SHARE_DWELL_SECONDS
    ) {
      return undefined;
    }
    schedule.dwellSeconds = dwell;
  }
  return Object.keys(schedule).length > 0 ? schedule : null;
}

function validWaypoint(value: unknown): RouteShareWaypoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lng, label } = value as Record<string, unknown>;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
    return null;
  }
  return label === undefined ? { lat, lng } : { lat, lng, label };
}

/**
 * Semantic validation of a route share payload (the Fastify body schema does
 * the structural bounds; this re-validates so stored snapshots read back from
 * jsonb go through the exact same gate).
 */
export function validateRouteShare(input: unknown): RouteSharePayload | null {
  if (typeof input !== "object" || input === null) return null;
  const { waypoints, mode, avoidHighways, avoidTolls, avoidFerries, scheduleVersion, schedules } =
    input as Record<string, unknown>;
  if (!ROUTE_SHARE_MODES.includes(mode as RouteShareMode)) return null;
  if (!validBikeRoutingOptions(input as Record<string, unknown>)) return null;
  if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > MAX_WAYPOINTS) {
    return null;
  }
  const parsed: RouteShareWaypoint[] = [];
  for (const candidate of waypoints) {
    const waypoint = validWaypoint(candidate);
    if (!waypoint) return null;
    parsed.push(waypoint);
  }
  for (const flag of [avoidHighways, avoidTolls, avoidFerries]) {
    if (flag !== undefined && typeof flag !== "boolean") return null;
  }
  const payload: RouteSharePayload = { waypoints: parsed, mode: mode as RouteShareMode };
  if (avoidHighways !== undefined) payload.avoidHighways = avoidHighways as boolean;
  if (avoidTolls !== undefined) payload.avoidTolls = avoidTolls as boolean;
  if (avoidFerries !== undefined) payload.avoidFerries = avoidFerries as boolean;
  if (mode === "cycling") {
    const bike = input as BikeRoutingOptions;
    if (bike.bikePreferSmoothSurfaces !== undefined)
      payload.bikePreferSmoothSurfaces = bike.bikePreferSmoothSurfaces;
    if (bike.bikeSpeedKmh !== undefined) payload.bikeSpeedKmh = bike.bikeSpeedKmh;
    if (bike.bikeProfile !== undefined) payload.bikeProfile = bike.bikeProfile;
    if (bike.bikeHillPreference !== undefined) payload.bikeHillPreference = bike.bikeHillPreference;
    if (bike.bikePreferQuietRoads !== undefined)
      payload.bikePreferQuietRoads = bike.bikePreferQuietRoads;
  }

  if (scheduleVersion !== undefined && scheduleVersion !== 1) return null;
  if (schedules !== undefined) {
    if (!Array.isArray(schedules) || schedules.length !== parsed.length) return null;
    const parsedSchedules: (ShareWaypointSchedule | null)[] = [];
    for (const candidate of schedules) {
      const schedule = validSchedule(candidate);
      if (schedule === undefined) return null;
      parsedSchedules.push(schedule);
    }
    if (parsedSchedules.some((schedule) => schedule !== null)) {
      payload.scheduleVersion = 1;
      payload.schedules = parsedSchedules;
    }
  }
  return payload;
}

function waypointName(waypoint: RouteShareWaypoint): string {
  if (waypoint.label?.trim()) return waypoint.label.trim();
  return `${waypoint.lat.toFixed(4)}, ${waypoint.lng.toFixed(4)}`;
}

export function routeShareLabel(route: RouteSharePayload): string {
  const first = route.waypoints[0];
  const last = route.waypoints[route.waypoints.length - 1];
  return `${waypointName(first)} → ${waypointName(last)}`;
}

/** Explicit-copy projection of DB rows into the frozen/public place shape. */
export function listSnapshotFrom(
  list: { name: string; icon: string | null },
  places: Array<{
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    note: string | null;
    placeId: string | null;
    fieldContributors?: SavedPlaceFieldContributors | null;
  }>,
): StoredListSnapshot | null {
  return parseStoredListSnapshot({
    name: list.name,
    icon: list.icon,
    places: places.map((place) => ({
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      note: place.note,
      placeId: place.placeId,
      ...(place.fieldContributors == null ? {} : { fieldContributors: place.fieldContributors }),
    })),
  });
}

export function parseStoredListSnapshot(value: unknown): StoredListSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, icon, places } = value as Record<string, unknown>;
  if (typeof name !== "string") return null;
  if (icon !== null && typeof icon !== "string") return null;
  if (!Array.isArray(places) || places.length > MAX_SNAPSHOT_PLACES) return null;
  const parsed: ExportPlace[] = [];
  for (const candidate of places) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const place = candidate as Record<string, unknown>;
    if (typeof place.name !== "string") return null;
    if (typeof place.lat !== "number" || typeof place.lng !== "number") return null;
    const fieldContributors =
      place.fieldContributors === undefined
        ? undefined
        : parseSavedPlaceContributors(place.fieldContributors);
    if (place.fieldContributors !== undefined && fieldContributors === undefined) return null;
    parsed.push({
      ...(fieldContributors === undefined ? {} : { fieldContributors }),
      name: place.name,
      address: typeof place.address === "string" ? place.address : null,
      lat: place.lat,
      lng: place.lng,
      note: typeof place.note === "string" ? place.note : null,
      placeId: typeof place.placeId === "string" ? place.placeId : null,
    });
  }
  const result = sharingListSnapshotSchema.safeParse({
    name,
    icon: (icon as string | null) ?? null,
    places: parsed,
  });
  return result.success ? result.data : null;
}

export function toPublicListShare(mode: ShareMode, snap: StoredListSnapshot): PublicListShare {
  return { type: "list", mode, name: snap.name, icon: snap.icon, places: snap.places };
}

export function toPublicRouteShare(route: RouteSharePayload): PublicRouteShare {
  return { type: "route", mode: "snapshot", route };
}

/** Owner projection: every field copied explicitly — never the hash or snapshot. */
export function toOwnerShare(row: {
  id: string;
  targetType: string;
  targetId: string | null;
  mode: string;
  label: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}): OwnerShare {
  return sharingOwnerSchema.parse({
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    mode: row.mode,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  });
}
