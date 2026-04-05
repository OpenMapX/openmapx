import type { BBox, TransportMode } from "../../services/transit/types";

export interface BBoxQuery {
  sw_lat: string;
  sw_lng: string;
  ne_lat: string;
  ne_lng: string;
}

export function parseBBox(q: BBoxQuery): BBox | null {
  const sw_lat = Number(q.sw_lat);
  const sw_lng = Number(q.sw_lng);
  const ne_lat = Number(q.ne_lat);
  const ne_lng = Number(q.ne_lng);
  if (
    !Number.isFinite(sw_lat) ||
    !Number.isFinite(sw_lng) ||
    !Number.isFinite(ne_lat) ||
    !Number.isFinite(ne_lng) ||
    sw_lat >= ne_lat
  ) {
    return null;
  }
  return [sw_lng, sw_lat, ne_lng, ne_lat];
}

/** Returns current UTC date as YYYY-MM-DD. */
export function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns current UTC time as HH:MM:SS. */
export function utcTime(): string {
  return new Date().toISOString().slice(11, 19);
}

export const bboxProperties = {
  sw_lat: { type: "string" },
  sw_lng: { type: "string" },
  ne_lat: { type: "string" },
  ne_lng: { type: "string" },
} as const;

export const bboxRequired = ["sw_lat", "sw_lng", "ne_lat", "ne_lng"] as const;

export const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

export interface PlaceQuery {
  lat: string;
  lng: string;
  name: string;
  place_id?: string;
}

export interface PlaceMinutesQuery extends PlaceQuery {
  minutes?: string;
}

export const placeProperties = {
  lat: { type: "string" },
  lng: { type: "string" },
  name: { type: "string" },
  place_id: { type: "string" },
} as const;

export const placeRequired = ["lat", "lng", "name"] as const;

export const placeSchema = {
  type: "object",
  required: [...placeRequired],
  properties: placeProperties,
} as const;

export const placeMinutesSchema = {
  type: "object",
  required: [...placeRequired],
  properties: { ...placeProperties, minutes: { type: "string" } },
} as const;

/** Parse and validate lat/lng/name from a query, returns null if invalid. */
export function parsePlaceQuery(q: PlaceQuery): { lat: number; lng: number; name: string } | null {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const name = q.name?.trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) return null;
  return { lat, lng, name };
}

/** Parse minutes with default and max cap. */
export function parseMinutes(raw: string | undefined, defaultVal = 60, max = 120): number | null {
  const minutes = Math.min(Number(raw ?? defaultVal), max);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/** Parse comma-separated modes string. */
export function parseModes(raw: string | undefined): TransportMode[] | undefined {
  return raw ? (raw.split(",").map((m) => m.trim()) as TransportMode[]) : undefined;
}

export interface MinutesQuery {
  minutes?: string;
}
