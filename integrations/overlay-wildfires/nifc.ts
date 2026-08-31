import type { IntegrationContext } from "@openmapx/integration-framework";
import { dedupeByFeatureId, nifcOffsetForZoom, splitAntimeridian } from "./bounds.js";
import { finiteNumber, isRecord, nonEmptyString } from "./normalization.js";
import { isWildfirePolygonGeometry, type WildfirePolygonGeometry } from "./polygon-geometry.js";
import {
  isAbortError,
  type NifcProperties,
  type NormalizedViewport,
  type WildfireProviderData,
  WildfireSourceError,
} from "./types.js";

const NIFC_QUERY_URL =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FEATURES = 2_000;

const NIFC_FIELDS = [
  "OBJECTID",
  "poly_IncidentName",
  "poly_GISAcres",
  "poly_DateCurrent",
  "poly_PolygonDateTime",
  "attr_IncidentName",
  "attr_IncidentSize",
  "attr_PercentContained",
  "attr_FireDiscoveryDateTime",
  "attr_ModifiedOnDateTime_dt",
  "attr_POOState",
  "attr_FireCause",
  "attr_IncidentTypeCategory",
].join(",");

type RawNifcFeature = {
  type?: unknown;
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
};

type NormalizedNifcFeature = GeoJSON.Feature<WildfirePolygonGeometry, NifcProperties>;

interface NifcCollection {
  features: unknown[];
  exceededTransferLimit: boolean;
}

function epochToIso(value: unknown): string | undefined {
  const epoch = finiteNumber(value);
  if (epoch === undefined) return undefined;
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function stableId(
  feature: RawNifcFeature,
  properties: Record<string, unknown>,
): string | undefined {
  const id = feature.id ?? properties.OBJECTID;
  if (id === null || id === undefined || id === "") return undefined;
  const value = String(id).replace(/^nifc:/, "");
  return value ? `nifc:${value}` : undefined;
}

export function buildNifcUrl(bounds: NormalizedViewport): string {
  const url = new URL(NIFC_QUERY_URL);
  url.searchParams.set("where", "attr_IncidentTypeCategory='WF'");
  url.searchParams.set("geometry", `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`);
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", NIFC_FIELDS);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("maxAllowableOffset", String(nifcOffsetForZoom(bounds.zoom)));
  url.searchParams.set("geometryPrecision", "5");
  return url.toString();
}

export function normalizeNifcFeature(input: unknown): NormalizedNifcFeature | null {
  if (!isRecord(input) || input.type !== "Feature") return null;
  const geometry = input.geometry;
  if (!isWildfirePolygonGeometry(geometry)) return null;
  const feature = input as RawNifcFeature;
  if (!isRecord(feature.properties)) return null;
  const raw = feature.properties;
  const id = stableId(feature, raw);
  if (!id || raw.attr_IncidentTypeCategory !== "WF") return null;

  const areaAcres = finiteNumber(raw.poly_GISAcres) ?? finiteNumber(raw.attr_IncidentSize);
  const containmentPercent = finiteNumber(raw.attr_PercentContained);
  const observedAt = epochToIso(raw.poly_PolygonDateTime);
  const updatedAt = epochToIso(raw.poly_DateCurrent) ?? epochToIso(raw.attr_ModifiedOnDateTime_dt);
  const discoveredAt = epochToIso(raw.attr_FireDiscoveryDateTime);
  if (
    (raw.poly_PolygonDateTime != null && raw.poly_PolygonDateTime !== "" && !observedAt) ||
    (raw.poly_DateCurrent != null &&
      raw.poly_DateCurrent !== "" &&
      !epochToIso(raw.poly_DateCurrent)) ||
    (raw.attr_ModifiedOnDateTime_dt != null &&
      raw.attr_ModifiedOnDateTime_dt !== "" &&
      !epochToIso(raw.attr_ModifiedOnDateTime_dt)) ||
    (raw.attr_FireDiscoveryDateTime != null &&
      raw.attr_FireDiscoveryDateTime !== "" &&
      !discoveredAt)
  ) {
    return null;
  }
  const validContainment =
    containmentPercent !== undefined && containmentPercent >= 0 && containmentPercent <= 100
      ? containmentPercent
      : undefined;
  const properties: NifcProperties = {
    id,
    kind: "reported-perimeter",
    provider: "nifc",
    coverage: "United States",
    name: nonEmptyString(raw.poly_IncidentName) ?? nonEmptyString(raw.attr_IncidentName) ?? id,
    ...(areaAcres === undefined ? {} : { areaAcres }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(discoveredAt === undefined ? {} : { discoveredAt }),
    ...(validContainment === undefined ? {} : { containmentPercent: validContainment }),
    ...(nonEmptyString(raw.attr_POOState) ? { region: nonEmptyString(raw.attr_POOState) } : {}),
    ...(nonEmptyString(raw.attr_FireCause) ? { cause: nonEmptyString(raw.attr_FireCause) } : {}),
  };

  return { type: "Feature", id, properties, geometry };
}

async function fetchNifcCollection(
  ctx: IntegrationContext,
  bounds: NormalizedViewport,
): Promise<NifcCollection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(buildNifcUrl(bounds), { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new WildfireSourceError("NIFC request aborted", {
          provider: "nifc",
          kind: "timeout",
          cause: error,
        });
      }
      throw new WildfireSourceError("NIFC request failed", {
        provider: "nifc",
        kind: "network",
        cause: error,
      });
    }
    if (!response.ok) {
      ctx.log.warn(`NIFC API returned ${response.status}`);
      throw new WildfireSourceError(`NIFC API returned ${response.status}`, {
        provider: "nifc",
        kind: "upstream-status",
        upstreamStatus: response.status,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new WildfireSourceError("NIFC request aborted", {
          provider: "nifc",
          kind: "timeout",
          cause: error,
        });
      }
      throw new WildfireSourceError("Invalid NIFC JSON response", {
        provider: "nifc",
        kind: "upstream-payload",
        cause: error,
      });
    }
    if (
      !isRecord(payload) ||
      payload.type !== "FeatureCollection" ||
      !Array.isArray(payload.features)
    ) {
      throw new WildfireSourceError("Invalid NIFC FeatureCollection", {
        provider: "nifc",
        kind: "upstream-payload",
      });
    }
    return {
      features: payload.features,
      exceededTransferLimit:
        isRecord(payload.properties) && payload.properties.exceededTransferLimit === true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadNifc(
  ctx: IntegrationContext,
  bounds: NormalizedViewport,
): Promise<WildfireProviderData> {
  const collections = await Promise.all(
    splitAntimeridian(bounds).map((part) => fetchNifcCollection(ctx, part)),
  );
  const upstreamTruncated = collections.some((collection) => collection.exceededTransferLimit);
  const normalized = collections.map((collection) => {
    const features: NormalizedNifcFeature[] = [];
    for (const feature of collection.features) {
      if (isRecord(feature) && isRecord(feature.properties)) {
        const category = feature.properties.attr_IncidentTypeCategory;
        if (category === "RX" || category === "CX") continue;
      }
      const normalizedFeature = normalizeNifcFeature(feature);
      if (!normalizedFeature) {
        throw new WildfireSourceError("Invalid NIFC feature", {
          provider: "nifc",
          kind: "upstream-payload",
        });
      }
      features.push(normalizedFeature);
    }
    return { type: "FeatureCollection" as const, features };
  });
  const merged = dedupeByFeatureId(normalized);
  const truncated = upstreamTruncated || merged.features.length > MAX_FEATURES;
  return {
    type: "FeatureCollection",
    features: merged.features.slice(0, MAX_FEATURES),
    source: "nifc",
    truncated,
  };
}
