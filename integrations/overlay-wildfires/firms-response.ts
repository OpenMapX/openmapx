import { isSourceId } from "./source-id";
import type { FireDensityCollection, FireFeatureCollection, FirmsInstrument } from "./types.js";

export const FIRMS_FETCHED_AT_HEADER = "X-OpenMapX-Fetched-At";
export const FIRMS_STALE_HEADER = "X-OpenMapX-Stale";
export const FIRMS_TRUNCATED_HEADER = "X-OpenMapX-Truncated";
export const FIRMS_SOURCES_HEADER = "X-OpenMapX-Sources";

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

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
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

function isPoint(value: unknown): value is GeoJSON.Point {
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

/** VIIRS rates a detection low, nominal or high; MODIS gives a percentage. */
function isConfidence(value: unknown, instrument: FirmsInstrument): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (instrument === "viirs") return value === "low" || value === "nominal" || value === "high";
  return /^(?:\d|[1-9]\d|100)$/.test(value);
}

function isFirmsFeature(value: unknown, expectedInstrument: FirmsInstrument): boolean {
  if (
    !isRecord(value) ||
    value.type !== "Feature" ||
    !isStableOptionalFeatureId(value.id) ||
    !isPoint(value.geometry) ||
    !isRecord(value.properties)
  ) {
    return false;
  }
  const properties = value.properties;
  const [longitude, latitude] = value.geometry.coordinates;
  return (
    properties.instrument === expectedInstrument &&
    isFiniteNumber(properties.latitude) &&
    properties.latitude >= -90 &&
    properties.latitude <= 90 &&
    properties.latitude === latitude &&
    isFiniteNumber(properties.longitude) &&
    properties.longitude >= -180 &&
    properties.longitude <= 180 &&
    properties.longitude === longitude &&
    (properties.brightness === null || isNonNegative(properties.brightness)) &&
    isNonNegative(properties.frp) &&
    isConfidence(properties.confidence, expectedInstrument) &&
    (properties.satellite === null ||
      (typeof properties.satellite === "string" && properties.satellite.trim().length > 0)) &&
    isCanonicalAcquisitionDate(properties.acqDate) &&
    typeof properties.acqTime === "string" &&
    ACQUISITION_TIME.test(properties.acqTime) &&
    (properties.dayNight === "D" || properties.dayNight === "N" || properties.dayNight === null) &&
    isFiniteNumber(properties.ageMs)
  );
}

/** Validates the complete hotspot response before any untrusted GeoJSON reaches MapLibre. */
export function isFirmsFeatureCollection(
  value: unknown,
  expectedInstrument: FirmsInstrument,
): value is FireFeatureCollection {
  return (
    isRecord(value) &&
    value.type === "FeatureCollection" &&
    Array.isArray(value.features) &&
    value.features.every((feature) => isFirmsFeature(feature, expectedInstrument))
  );
}

function isDensityFeature(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "Feature" || !isPoint(value.geometry)) return false;
  const properties = value.properties;
  return (
    isRecord(properties) &&
    Number.isInteger(properties.count) &&
    (properties.count as number) >= 1 &&
    isNonNegative(properties.frpSum) &&
    isNonNegative(properties.frpMax)
  );
}

/** Validates a density response: cell points with their counts, and the sources behind them. */
export function isFireDensityCollection(value: unknown): value is FireDensityCollection {
  return (
    isRecord(value) &&
    value.type === "FeatureCollection" &&
    Array.isArray(value.features) &&
    value.features.every(isDensityFeature) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSourceId)
  );
}

export interface FirmsResponseMetadata {
  fetchedAt: number;
  stale: boolean;
  truncated: boolean;
  /** The feed ids the server named; empty when it named none. */
  sources: string[];
}

/** Reads the response metadata headers; malformed values read as fresh on receipt. */
export function readFirmsResponseMetadata(
  headers: Pick<Headers, "get"> | undefined,
  receivedAt: number,
): FirmsResponseMetadata {
  const fetchedAt = headers?.get(FIRMS_FETCHED_AT_HEADER);
  const stale = headers?.get(FIRMS_STALE_HEADER);
  const sources = (headers?.get(FIRMS_SOURCES_HEADER) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(isSourceId);
  const truncated = headers?.get(FIRMS_TRUNCATED_HEADER) === "true";
  if (isCanonicalIsoUtcTimestamp(fetchedAt) && (stale === "true" || stale === "false")) {
    return { fetchedAt: Date.parse(fetchedAt), stale: stale === "true", truncated, sources };
  }
  return { fetchedAt: receivedAt, stale: false, truncated, sources };
}
