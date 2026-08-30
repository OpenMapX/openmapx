import { createHash } from "node:crypto";

import type { AirQualityStandardId, Pollutant } from "@openmapx/air-quality";
import {
  QueryValidationError,
  type RouteQuery,
  scalarQuery,
} from "@openmapx/integration-framework";

const STANDARD_IDS = new Set<AirQualityStandardId>([
  "us-epa-2024",
  "eu-eea-current",
  "uk-daqi-current",
  "in-naqi-current",
  "cn-hj633-2026",
  "ca-aqhi-current",
]);
const POLLUTANTS = new Set<Pollutant>(["pm25", "pm10", "o3", "no2", "so2", "co", "nh3", "no"]);

function required(query: RouteQuery, key: string): string {
  const value = scalarQuery(query, key);
  if (value === undefined || value.trim() === "")
    throw new QueryValidationError(key, "is required");
  return value;
}

function finiteNumber(query: RouteQuery, key: string): number {
  const value = Number(required(query, key));
  if (!Number.isFinite(value)) throw new QueryValidationError(key, "must be finite");
  return value;
}

function boundedInteger(
  query: RouteQuery,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = scalarQuery(query, key);
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new QueryValidationError(key, `must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function queryHash(value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("base64url");
  return `aq_q1_${digest}`;
}

export interface ParsedPointQuery {
  latitude: number;
  longitude: number;
  evaluatedAt: string;
  countryCode?: string;
  subdivisionCode?: string;
  comparisonStandard?: AirQualityStandardId;
  hours?: number;
  queryHash: string;
}

export function parsePointQuery(
  query: RouteQuery,
  options: { forecast: boolean; now?: () => number },
): ParsedPointQuery {
  const latitude = finiteNumber(query, "lat");
  const longitude = finiteNumber(query, "lng");
  if (latitude < -90 || latitude > 90)
    throw new QueryValidationError("lat", "must be from -90 to 90");
  if (longitude < -180 || longitude > 180)
    throw new QueryValidationError("lng", "must be from -180 to 180");

  const countryCode = scalarQuery(query, "countryCode");
  if (countryCode !== undefined && !/^[A-Z]{2}$/.test(countryCode))
    throw new QueryValidationError("countryCode", "must be uppercase ISO alpha-2");
  const subdivisionCode = scalarQuery(query, "subdivisionCode");
  if (subdivisionCode !== undefined && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(subdivisionCode))
    throw new QueryValidationError("subdivisionCode", "must be an uppercase ISO 3166-2 code");
  if (subdivisionCode && countryCode && !subdivisionCode.startsWith(`${countryCode}-`))
    throw new QueryValidationError("subdivisionCode", "must match countryCode");

  const comparison = scalarQuery(query, "comparisonStandard");
  if (comparison !== undefined && !STANDARD_IDS.has(comparison as AirQualityStandardId))
    throw new QueryValidationError("comparisonStandard", "is not supported");
  const comparisonStandard = comparison as AirQualityStandardId | undefined;
  const hours = options.forecast ? boundedInteger(query, "hours", 48, 1, 120) : undefined;
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now))
    throw new TypeError("Air-quality request clock returned an invalid time");
  const evaluatedAt = new Date(now).toISOString();
  const hashInput = {
    kind: options.forecast ? "forecast" : "current",
    latitude,
    longitude,
    countryCode: countryCode ?? null,
    subdivisionCode: subdivisionCode ?? null,
    comparisonStandard: comparisonStandard ?? null,
    hours: hours ?? null,
  };
  return {
    latitude,
    longitude,
    evaluatedAt,
    ...(countryCode ? { countryCode } : {}),
    ...(subdivisionCode ? { subdivisionCode } : {}),
    ...(comparisonStandard ? { comparisonStandard } : {}),
    ...(hours === undefined ? {} : { hours }),
    queryHash: queryHash(hashInput),
  };
}

export interface ParsedStationQuery {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
  pollutant: Pollutant;
  limit: number;
  cursor?: string;
  queryHash: string;
}

export function parseStationQuery(query: RouteQuery): ParsedStationQuery {
  const south = finiteNumber(query, "south");
  const west = finiteNumber(query, "west");
  const north = finiteNumber(query, "north");
  const east = finiteNumber(query, "east");
  if (
    south < -90 ||
    north > 90 ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south >= north
  )
    throw new QueryValidationError("bbox", "is outside WGS84 bounds");
  const longitudeSpan = west <= east ? east - west : 180 - west + (east + 180);
  if (north - south > 20 || longitudeSpan > 30)
    throw new QueryValidationError("bbox", "may span at most 20 latitude and 30 longitude degrees");

  const zoom = boundedInteger(query, "zoom", 0, 0, 22);
  const limit = boundedInteger(query, "limit", 500, 1, 500);
  const rawPollutant = scalarQuery(query, "pollutant") ?? "pm25";
  if (!POLLUTANTS.has(rawPollutant as Pollutant))
    throw new QueryValidationError("pollutant", "is not supported");
  const pollutant = rawPollutant as Pollutant;
  const cursor = scalarQuery(query, "cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 2_048))
    throw new QueryValidationError("cursor", "is invalid");
  const hashInput = { south, west, north, east, zoom, pollutant, limit };
  return {
    south,
    west,
    north,
    east,
    zoom,
    pollutant,
    limit,
    ...(cursor ? { cursor } : {}),
    queryHash: queryHash(hashInput),
  };
}
