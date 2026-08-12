import type { IntegrationContext } from "@openmapx/integration-framework";
import { dedupeByFeatureId, splitAntimeridian } from "./bounds.js";
import {
  type EffisProperties,
  isAbortError,
  type NormalizedViewport,
  type WildfireProviderData,
  WildfireSourceError,
  type WildfireSourceErrorOptions,
} from "./types.js";

const EFFIS_WFS_URL = "https://maps.effis.emergency.copernicus.eu/effis";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FEATURES = 2_000;
const REQUESTED_FEATURES = MAX_FEATURES + 1;

type EffisGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;
type RawEffisFeature = {
  type?: unknown;
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
};
type NormalizedEffisFeature = GeoJSON.Feature<EffisGeometry, EffisProperties>;

export class EffisSourceError extends WildfireSourceError {
  constructor(message: string, options: Omit<WildfireSourceErrorOptions, "provider">) {
    super(message, { provider: "effis", ...options });
    this.name = "EffisSourceError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result ? result : undefined;
}

function optionalString(value: unknown): string | undefined {
  const result = nonEmptyString(value);
  return result?.toUpperCase() === "N.A." ? undefined : result;
}

function sourceDateToIso(value: unknown): string | undefined {
  const string = nonEmptyString(value);
  if (!string) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(string)
    ? `${string.replace(" ", "T")}Z`
    : string;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isPosition(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  if (!value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return false;
  }
  return value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function positionsEqual(first: number[], second: number[]): boolean {
  return (
    first.length === second.length &&
    first.every((coordinate, index) => coordinate === second[index])
  );
}

function isLinearRing(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(isPosition) &&
    positionsEqual(value[0], value[value.length - 1])
  );
}

function isPolygonCoordinates(value: unknown): value is number[][][] {
  return Array.isArray(value) && value.length > 0 && value.every(isLinearRing);
}

function isMultiPolygonCoordinates(value: unknown): value is number[][][][] {
  return Array.isArray(value) && value.length > 0 && value.every(isPolygonCoordinates);
}

function validGeometry(value: unknown): value is EffisGeometry {
  if (!isObject(value) || (value.type !== "Polygon" && value.type !== "MultiPolygon")) return false;
  return value.type === "Polygon"
    ? isPolygonCoordinates(value.coordinates)
    : isMultiPolygonCoordinates(value.coordinates);
}

function stableId(
  feature: RawEffisFeature,
  properties: Record<string, unknown>,
): string | undefined {
  for (const value of [properties.id, feature.id, properties.ID]) {
    if (value === null || value === undefined || value === "") continue;
    const id = String(value)
      .trim()
      .replace(/^effis:/, "");
    if (id) return `effis:${id}`;
  }
  return undefined;
}

export function buildEffisUrl(bounds: NormalizedViewport): string {
  const url = new URL(EFFIS_WFS_URL);
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "1.1.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typename", "ms:modis.ba.poly.week");
  url.searchParams.set("outputformat", "geojson");
  url.searchParams.set(
    "bbox",
    `${bounds.south},${bounds.west},${bounds.north},${bounds.east},EPSG:4326`,
  );
  url.searchParams.set("maxfeatures", String(REQUESTED_FEATURES));
  return url.toString();
}

export function normalizeEffisFeature(input: unknown): NormalizedEffisFeature | null {
  if (!isObject(input) || input.type !== "Feature" || !validGeometry(input.geometry)) return null;
  const feature = input as RawEffisFeature;
  if (!isObject(feature.properties)) return null;
  const raw = feature.properties;
  const id = stableId(feature, raw);
  const areaHectares = finiteNumber(raw.AREA_HA);
  if (!id || areaHectares === undefined) return null;

  const detectedAt = sourceDateToIso(raw.FIREDATE);
  const updatedAt = sourceDateToIso(raw.UPDATED) ?? sourceDateToIso(raw.LASTUPDATE);
  const countryCode = optionalString(raw.COUNTRY);
  const region = optionalString(raw.PROVINCE) ?? optionalString(raw.REGION);
  const locality = optionalString(raw.COMMUNE) ?? optionalString(raw.LOCALITY);
  const sourceClass =
    optionalString(raw.CLASS) ?? optionalString(raw.SOURCE_CLASS) ?? optionalString(raw.SOURCE);
  const properties: EffisProperties = {
    id,
    kind: "satellite-burned-area",
    provider: "effis",
    areaHectares,
    ...(detectedAt === undefined ? {} : { detectedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(region === undefined ? {} : { region }),
    ...(locality === undefined ? {} : { locality }),
    ...(sourceClass === undefined ? {} : { sourceClass }),
  };

  return { type: "Feature", id, properties, geometry: input.geometry };
}

function isXmlException(body: string, contentType: string | null): boolean {
  return (
    contentType?.toLowerCase().includes("xml") === true ||
    /^\s*</.test(body) ||
    /<(?:\w+:)?(?:ServiceExceptionReport|ExceptionReport|ServiceException)\b/i.test(body)
  );
}

async function fetchEffisCollection(
  ctx: IntegrationContext,
  bounds: NormalizedViewport,
): Promise<GeoJSON.FeatureCollection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(buildEffisUrl(bounds), {
        headers: { Accept: "application/geo+json, application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new EffisSourceError("EFFIS request aborted", { kind: "timeout", cause: error });
      }
      throw new EffisSourceError("EFFIS request failed", { kind: "network", cause: error });
    }
    if (!response.ok) {
      ctx.log.warn(`EFFIS API returned ${response.status}`);
      throw new EffisSourceError(`EFFIS API returned ${response.status}`, {
        kind: "upstream-status",
        upstreamStatus: response.status,
      });
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new EffisSourceError("EFFIS request aborted", { kind: "timeout", cause: error });
      }
      throw new EffisSourceError("Invalid EFFIS upstream response", {
        kind: "upstream-payload",
        cause: error,
      });
    }
    if (isXmlException(body, response.headers.get("content-type"))) {
      throw new EffisSourceError("Invalid EFFIS upstream response", { kind: "upstream-payload" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new EffisSourceError("Invalid EFFIS upstream response", {
        kind: "upstream-payload",
        cause: error,
      });
    }
    if (
      !isObject(payload) ||
      payload.type !== "FeatureCollection" ||
      !Array.isArray(payload.features)
    ) {
      throw new EffisSourceError("Invalid EFFIS upstream response", { kind: "upstream-payload" });
    }
    return payload as unknown as GeoJSON.FeatureCollection;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadEffis(
  ctx: IntegrationContext,
  bounds: NormalizedViewport,
): Promise<WildfireProviderData> {
  const collections = await Promise.all(
    splitAntimeridian(bounds).map((part) => fetchEffisCollection(ctx, part)),
  );
  const upstreamTruncated = collections.some(
    (collection) => collection.features.length >= REQUESTED_FEATURES,
  );
  const normalized = collections.map((collection) => ({
    type: "FeatureCollection" as const,
    features: collection.features
      .map((feature) => normalizeEffisFeature(feature))
      .filter((feature): feature is NormalizedEffisFeature => feature !== null),
  }));
  const merged = dedupeByFeatureId(normalized);
  const truncated = upstreamTruncated || merged.features.length > MAX_FEATURES;
  return {
    type: "FeatureCollection",
    features: merged.features.slice(0, MAX_FEATURES),
    source: "effis",
    truncated,
  };
}
