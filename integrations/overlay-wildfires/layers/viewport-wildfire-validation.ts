import type { EffisProperties, NifcProperties, WildfireFeatureCollection } from "../types";

export type ViewportWildfireSourceId = "nifc" | "effis";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isPosition(value: unknown): value is GeoJSON.Position {
  if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) return false;
  const [longitude, latitude] = value;
  return (
    typeof longitude === "number" &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === "number" &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function positionsEqual(first: GeoJSON.Position, last: GeoJSON.Position): boolean {
  return (
    first.length === last.length && first.every((coordinate, index) => coordinate === last[index])
  );
}

function isLinearRing(value: unknown): value is GeoJSON.Position[] {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
  return positionsEqual(value[0] as GeoJSON.Position, value.at(-1) as GeoJSON.Position);
}

function isPolygonCoordinates(value: unknown): value is GeoJSON.Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isLinearRing);
}

function isPolygonGeometry(value: unknown): value is GeoJSON.Polygon | GeoJSON.MultiPolygon {
  if (!isRecord(value)) return false;
  if (value.type === "Polygon") return isPolygonCoordinates(value.coordinates);
  return (
    value.type === "MultiPolygon" &&
    Array.isArray(value.coordinates) &&
    value.coordinates.length > 0 &&
    value.coordinates.every(isPolygonCoordinates)
  );
}

function hasStableId(
  feature: UnknownRecord,
  properties: UnknownRecord,
  sourceId: ViewportWildfireSourceId,
): boolean {
  return (
    typeof feature.id === "string" &&
    feature.id.startsWith(`${sourceId}:`) &&
    feature.id.length > sourceId.length + 1 &&
    properties.id === feature.id
  );
}

function isNifcProperties(value: UnknownRecord): value is UnknownRecord & NifcProperties {
  return (
    value.kind === "reported-perimeter" &&
    value.provider === "nifc" &&
    value.coverage === "United States" &&
    typeof value.name === "string" &&
    isOptionalNonNegativeNumber(value.areaAcres) &&
    isOptionalString(value.observedAt) &&
    isOptionalString(value.updatedAt) &&
    isOptionalString(value.discoveredAt) &&
    (value.containmentPercent === undefined ||
      (typeof value.containmentPercent === "number" &&
        Number.isFinite(value.containmentPercent) &&
        value.containmentPercent >= 0 &&
        value.containmentPercent <= 100)) &&
    isOptionalString(value.region) &&
    isOptionalString(value.cause)
  );
}

function isEffisProperties(value: UnknownRecord): value is UnknownRecord & EffisProperties {
  return (
    value.kind === "satellite-burned-area" &&
    value.provider === "effis" &&
    isOptionalString(value.detectedAt) &&
    isOptionalString(value.updatedAt) &&
    isOptionalString(value.countryCode) &&
    isOptionalString(value.region) &&
    isOptionalString(value.locality) &&
    isOptionalNonNegativeNumber(value.areaHectares) &&
    isOptionalString(value.sourceClass)
  );
}

function isProviderFeature(value: unknown, sourceId: ViewportWildfireSourceId): boolean {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.properties)) return false;
  if (!hasStableId(value, value.properties, sourceId) || !isPolygonGeometry(value.geometry)) {
    return false;
  }
  return sourceId === "nifc"
    ? isNifcProperties(value.properties)
    : isEffisProperties(value.properties);
}

/** Validates the complete client/server contract before GeoJSON reaches MapLibre. */
export function isViewportWildfireFeatureCollection(
  value: unknown,
  sourceId: ViewportWildfireSourceId,
): value is WildfireFeatureCollection {
  if (!isRecord(value)) return false;
  return (
    value.type === "FeatureCollection" &&
    Array.isArray(value.features) &&
    value.features.every((feature) => isProviderFeature(feature, sourceId)) &&
    value.source === sourceId &&
    typeof value.fetchedAt === "string" &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.stale === "boolean" &&
    typeof value.truncated === "boolean"
  );
}
