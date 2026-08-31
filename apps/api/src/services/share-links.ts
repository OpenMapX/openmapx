import { createHash, randomBytes } from "node:crypto";
import type { ExportPlace } from "../utils/geo-export";

/** Route-schema pattern for the public token param (43-char base64url plus slack). */
export const SHARE_TOKEN_PATTERN = "^[A-Za-z0-9_-]{20,64}$";
export const MAX_SHARES_PER_USER = 100;
export const MAX_SNAPSHOT_PLACES = 1000;
export const MAX_EXPIRES_IN_DAYS = 365;
const MAX_WAYPOINTS = 10;
const MAX_LABEL_LENGTH = 200;

export type ShareMode = "live" | "snapshot";
export type ShareTargetType = "list" | "route";

const ROUTE_SHARE_MODES = ["driving", "walking", "cycling", "motorcycle"] as const;
export type RouteShareMode = (typeof ROUTE_SHARE_MODES)[number];

export interface RouteShareWaypoint {
  lat: number;
  lng: number;
  label?: string;
}

export interface RouteSharePayload {
  waypoints: RouteShareWaypoint[];
  mode: RouteShareMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
}

export interface StoredListSnapshot {
  name: string;
  icon: string | null;
  places: ExportPlace[];
}

export interface PublicListShare extends StoredListSnapshot {
  type: "list";
  mode: ShareMode;
}

export interface PublicRouteShare {
  type: "route";
  mode: "snapshot";
  route: RouteSharePayload;
}

export interface OwnerShare {
  id: string;
  targetType: string;
  targetId: string | null;
  mode: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

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
  const { waypoints, mode, avoidHighways, avoidTolls, avoidFerries } = input as Record<
    string,
    unknown
  >;
  if (!ROUTE_SHARE_MODES.includes(mode as RouteShareMode)) return null;
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
  }>,
): StoredListSnapshot {
  return {
    name: list.name,
    icon: list.icon,
    places: places.map((place) => ({
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      note: place.note,
      placeId: place.placeId,
    })),
  };
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
    parsed.push({
      name: place.name,
      address: typeof place.address === "string" ? place.address : null,
      lat: place.lat,
      lng: place.lng,
      note: typeof place.note === "string" ? place.note : null,
      placeId: typeof place.placeId === "string" ? place.placeId : null,
    });
  }
  return { name, icon: (icon as string | null) ?? null, places: parsed };
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
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    mode: row.mode,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}
