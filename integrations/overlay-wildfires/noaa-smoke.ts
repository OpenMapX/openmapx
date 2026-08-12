import type { IntegrationContext } from "@openmapx/integration-framework";
import type { NoaaSmokeProperties, WildfireProviderData } from "./types.js";

const NOAA_HMS_QUERY_URL =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query";
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1_000;
const MAX_FEATURES = 2_000;
const MAX_PAGES = MAX_FEATURES / PAGE_SIZE;
const NOAA_HMS_FIELDS = ["FID", "Satellite", "Start", "End_", "Density"].join(",");

type NoaaSmokeGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;
type RawNoaaSmokeFeature = {
  type?: unknown;
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
};
type NormalizedNoaaSmokeFeature = GeoJSON.Feature<NoaaSmokeGeometry, NoaaSmokeProperties>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result ? result : undefined;
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

function validGeometry(value: unknown): value is NoaaSmokeGeometry {
  if (!isObject(value) || (value.type !== "Polygon" && value.type !== "MultiPolygon")) return false;
  return value.type === "Polygon"
    ? isPolygonCoordinates(value.coordinates)
    : isMultiPolygonCoordinates(value.coordinates);
}

function stableId(
  feature: RawNoaaSmokeFeature,
  properties: Record<string, unknown>,
): string | undefined {
  for (const value of [properties.FID, feature.id]) {
    if (value === null || value === undefined || value === "") continue;
    const id = String(value)
      .trim()
      .replace(/^noaa-hms:/, "");
    if (id) return `noaa-hms:${id}`;
  }
  return undefined;
}

export function buildNoaaSmokeUrl(offset = 0): string {
  const url = new URL(NOAA_HMS_QUERY_URL);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", NOAA_HMS_FIELDS);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("orderByFields", "FID ASC");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

export function parseHmsUtc(value: string): string | undefined {
  const match = /^(\d{4})(\d{3})\s+(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, year, ordinal, hour, minute] = match;
  const ordinalNumber = Number(ordinal);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  if (
    ordinalNumber < 1 ||
    ordinalNumber > 366 ||
    hourNumber < 0 ||
    hourNumber > 23 ||
    minuteNumber < 0 ||
    minuteNumber > 59
  ) {
    return undefined;
  }
  const ms = Date.UTC(Number(year), 0, ordinalNumber, hourNumber, minuteNumber);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function normalizeSmokeDensity(value: unknown): NoaaSmokeProperties["density"] | undefined {
  const density = nonEmptyString(value)?.toLowerCase();
  return density === "light" || density === "medium" || density === "heavy" ? density : undefined;
}

export function normalizeNoaaSmokeFeature(input: unknown): NormalizedNoaaSmokeFeature | null {
  if (!isObject(input) || input.type !== "Feature") return null;
  const geometry = input.geometry;
  if (!validGeometry(geometry)) return null;
  const feature = input as RawNoaaSmokeFeature;
  if (!isObject(feature.properties)) return null;
  const raw = feature.properties;
  const id = stableId(feature, raw);
  const density = normalizeSmokeDensity(raw.Density);
  if (!id || !density) return null;

  const startedAt = typeof raw.Start === "string" ? parseHmsUtc(raw.Start) : undefined;
  const endedAt = typeof raw.End_ === "string" ? parseHmsUtc(raw.End_) : undefined;
  const satellite = nonEmptyString(raw.Satellite);
  const properties: NoaaSmokeProperties = {
    id,
    kind: "observed-smoke",
    provider: "noaa-hms",
    density,
    ...(satellite === undefined ? {} : { satellite }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
  return { type: "Feature", id, properties, geometry };
}

interface NoaaSmokeCollection {
  features: unknown[];
  exceededTransferLimit: boolean;
}

async function fetchNoaaSmokePage(
  ctx: IntegrationContext,
  offset: number,
): Promise<NoaaSmokeCollection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(buildNoaaSmokeUrl(offset), { signal: controller.signal });
    if (!response.ok) {
      ctx.log.warn(`NOAA API returned ${response.status}`);
      throw new Error(`NOAA API returned ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Invalid NOAA JSON response");
    }
    if (isObject(payload) && "error" in payload) throw new Error("NOAA ArcGIS error response");
    if (
      !isObject(payload) ||
      payload.type !== "FeatureCollection" ||
      !Array.isArray(payload.features)
    ) {
      throw new Error("Invalid NOAA FeatureCollection");
    }
    return {
      features: payload.features,
      exceededTransferLimit:
        isObject(payload.properties) && payload.properties.exceededTransferLimit === true,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("NOAA request aborted");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadNoaaSmoke(ctx: IntegrationContext): Promise<WildfireProviderData> {
  const features: NormalizedNoaaSmokeFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const collection = await fetchNoaaSmokePage(ctx, page * PAGE_SIZE);
    features.push(
      ...collection.features
        .map((feature) => normalizeNoaaSmokeFeature(feature))
        .filter((feature): feature is NormalizedNoaaSmokeFeature => feature !== null),
    );
    if (!collection.exceededTransferLimit) {
      return {
        type: "FeatureCollection",
        features,
        source: "noaa-hms",
        truncated: false,
      };
    }
  }
  throw new Error(`NOAA response exceeded ${MAX_FEATURES.toLocaleString("en-US")} feature cap`);
}
