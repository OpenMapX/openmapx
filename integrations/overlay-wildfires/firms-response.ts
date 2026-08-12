import type { FireFeatureCollection, FirmsSource } from "./firms.js";

export const FIRMS_FETCHED_AT_HEADER = "X-OpenMapX-Fetched-At";
export const FIRMS_STALE_HEADER = "X-OpenMapX-Stale";

const CANONICAL_ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACQUISITION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACQUISITION_TIME = /^(?:[01]\d|2[0-3])[0-5]\d$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanonicalIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_ISO_UTC_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalAcquisitionDate(value: unknown): value is string {
  if (typeof value !== "string" || !ACQUISITION_DATE.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function isStableOptionalFeatureId(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isFirmsPoint(value: unknown): value is GeoJSON.Point {
  if (!isRecord(value) || value.type !== "Point" || !Array.isArray(value.coordinates)) {
    return false;
  }
  const [longitude, latitude] = value.coordinates;
  return (
    value.coordinates.length >= 2 &&
    value.coordinates.every(isFiniteNumber) &&
    isFiniteNumber(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    isFiniteNumber(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function isConfidence(value: unknown, source: FirmsSource): value is string {
  if (typeof value !== "string") return false;
  if (source === "VIIRS_SNPP_NRT") {
    return value === "nominal" || value === "high" || value === "n" || value === "h";
  }
  return /^(?:[5-9]\d|100)$/.test(value);
}

function isFirmsFeature(value: unknown, expectedSource: FirmsSource): boolean {
  if (
    !isRecord(value) ||
    value.type !== "Feature" ||
    !isStableOptionalFeatureId(value.id) ||
    !isFirmsPoint(value.geometry) ||
    !isRecord(value.properties)
  ) {
    return false;
  }
  const properties = value.properties;
  const [longitude, latitude] = value.geometry.coordinates;
  return (
    properties.source === expectedSource &&
    isFiniteNumber(properties.latitude) &&
    properties.latitude >= -90 &&
    properties.latitude <= 90 &&
    properties.latitude === latitude &&
    isFiniteNumber(properties.longitude) &&
    properties.longitude >= -180 &&
    properties.longitude <= 180 &&
    properties.longitude === longitude &&
    isFiniteNumber(properties.brightness) &&
    properties.brightness >= 0 &&
    isFiniteNumber(properties.frp) &&
    properties.frp >= 0 &&
    isConfidence(properties.confidence, expectedSource) &&
    typeof properties.satellite === "string" &&
    properties.satellite.trim().length > 0 &&
    isCanonicalAcquisitionDate(properties.acqDate) &&
    typeof properties.acqTime === "string" &&
    ACQUISITION_TIME.test(properties.acqTime) &&
    (properties.dayNight === "D" || properties.dayNight === "N") &&
    isFiniteNumber(properties.ageMs)
  );
}

/** Validates the complete FIRMS response before any untrusted GeoJSON reaches MapLibre. */
export function isFirmsFeatureCollection(
  value: unknown,
  expectedSource: FirmsSource,
): value is FireFeatureCollection {
  return (
    isRecord(value) &&
    value.type === "FeatureCollection" &&
    Array.isArray(value.features) &&
    value.features.every((feature) => isFirmsFeature(feature, expectedSource))
  );
}

export interface FirmsResponseMetadata {
  fetchedAt: number;
  stale: boolean;
}

/** Reads new-server metadata, with legacy/malformed responses treated as fresh on receipt. */
export function readFirmsResponseMetadata(
  headers: Pick<Headers, "get"> | undefined,
  receivedAt: number,
): FirmsResponseMetadata {
  const fetchedAt = headers?.get(FIRMS_FETCHED_AT_HEADER);
  const stale = headers?.get(FIRMS_STALE_HEADER);
  if (isCanonicalIsoUtcTimestamp(fetchedAt) && (stale === "true" || stale === "false")) {
    return { fetchedAt: Date.parse(fetchedAt), stale: stale === "true" };
  }
  return { fetchedAt: receivedAt, stale: false };
}
