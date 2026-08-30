import { createHash } from "node:crypto";

import type {
  AirQualityBasis,
  AirQualitySourceRef,
  ProviderEvidence,
  PublishedIndexInput,
} from "@openmapx/air-quality";
import { indexId, observationId } from "@openmapx/air-quality/ids";
import type {
  AirQualityProvider,
  ForecastAirQualityQuery,
  IntegrationContext,
  PointAirQualityQuery,
  ProviderCallContext,
} from "@openmapx/integration-framework";
import { z } from "zod";

const CURRENT_ENDPOINT = "https://api.weather.gc.ca/collections/aqhi-observations-realtime/items";
const FORECAST_ENDPOINT = "https://api.weather.gc.ca/collections/aqhi-forecasts-realtime/items";
const SOURCE_ID = "eccc-aqhi-geomet";
const METHOD_REVISION = "eccc-geomet-aqhi-collections-2026-08-30";
const SEARCH_RADIUS_KM = 100;
const CURRENT_LIMIT = 100;
const FORECAST_LIMIT = 5_000;
const CURRENT_VALIDITY_MS = 2 * 60 * 60_000;
const FORECAST_VALIDITY_MS = 60 * 60_000;

const source: AirQualitySourceRef = {
  sourceId: SOURCE_ID,
  name: "ECCC GeoMet AQHI observations and forecasts",
  url: "https://api.weather.gc.ca/collections/aqhi-observations-realtime",
  owner: "Environment and Climate Change Canada",
  license: {
    name: "Open Government Licence – Canada",
    url: "https://open.canada.ca/en/open-government-licence-canada",
  },
  methodologyUrl: "https://eccc-msc.github.io/open-data/msc-data/aqhi/readme_aqhi_en/",
  attribution: "Environment and Climate Change Canada",
};

const coordinatesSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const geometrySchema = z.object({ type: z.literal("Point"), coordinates: coordinatesSchema });
const sharedProperties = {
  id: z.string().min(1).max(256),
  location_name_en: z.string().min(1).max(256),
  location_name_fr: z.string().min(1).max(256),
  location_id: z.string().regex(/^[A-Z0-9]{5}$/),
  aqhi: z.number().finite().nonnegative().max(1_000),
};
const currentFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string().min(1).max(256),
  geometry: geometrySchema,
  properties: z.object({
    ...sharedProperties,
    aqhi_type: z.literal("AQHI-Observation"),
    observation_type: z.literal("original"),
    observation_datetime: z.iso.datetime({ offset: true }),
    latest: z.literal(true),
  }),
});
const forecastFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string().min(1).max(256),
  geometry: geometrySchema,
  properties: z.object({
    ...sharedProperties,
    aqhi_type: z.literal("AQHI-Forecast"),
    forecast_type: z.literal("original"),
    publication_datetime: z.iso.datetime({ offset: true }),
    forecast_datetime: z.iso.datetime({ offset: true }),
  }),
});
const collectionFields = {
  type: z.literal("FeatureCollection"),
  numberMatched: z.number().int().nonnegative(),
  numberReturned: z.number().int().nonnegative(),
};
const currentCollectionSchema = z.object({
  ...collectionFields,
  features: z.array(currentFeatureSchema).max(CURRENT_LIMIT),
});
const forecastCollectionSchema = z.object({
  ...collectionFields,
  features: z.array(forecastFeatureSchema).max(FORECAST_LIMIT),
});

type CurrentFeature = z.infer<typeof currentFeatureSchema>;
type ForecastFeature = z.infer<typeof forecastFeatureSchema>;
type Feature = CurrentFeature | ForecastFeature;

export class EcccProviderError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_response" | "upstream_failure" = "invalid_response",
  ) {
    super(message);
    this.name = "EcccProviderError";
  }
}

function absolute(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new EcccProviderError("Invalid ECCC instant");
  return new Date(parsed).toISOString();
}

function bbox(query: PointAirQualityQuery): string {
  const latitudeSpan = SEARCH_RADIUS_KM / 111.32;
  const longitudeScale = Math.max(0.05, Math.cos((query.latitude * Math.PI) / 180));
  const longitudeSpan = Math.min(180, SEARCH_RADIUS_KM / (111.32 * longitudeScale));
  return [
    Math.max(-180, query.longitude - longitudeSpan),
    Math.max(-90, query.latitude - latitudeSpan),
    Math.min(180, query.longitude + longitudeSpan),
    Math.min(90, query.latitude + latitudeSpan),
  ]
    .map((value) => value.toFixed(6))
    .join(",");
}

function distanceMeters(
  query: PointAirQualityQuery,
  coordinates: readonly [number, number],
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(coordinates[1] - query.latitude);
  const dLng = radians(coordinates[0] - query.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(query.latitude)) * Math.cos(radians(coordinates[1])) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function cacheKey(mode: "current" | "forecast", params: Record<string, unknown>): string {
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("base64url");
  return `${mode}:v1:${digest}`;
}

async function fetchCollection<T>(
  ctx: IntegrationContext,
  call: ProviderCallContext,
  input: {
    mode: "current" | "forecast";
    endpoint: string;
    params: Record<string, string | number | boolean>;
    limit: number;
    maxBytes: number;
    schema: z.ZodType<T>;
    ttlSeconds: number;
  },
): Promise<T> {
  return ctx.cache.withCache(
    cacheKey(input.mode, input.params),
    input.ttlSeconds,
    async (signal) => {
      const response = await ctx.http.getResponse<unknown>(input.endpoint, {
        params: input.params,
        signal,
        timeoutMs: Math.max(250, call.deadlineAt - Date.now()),
        maxBytes: input.maxBytes,
        contentTypes: ["application/json", "application/geo+json"],
        redirect: "error",
      });
      if (response.status < 200 || response.status >= 300)
        throw new EcccProviderError(`ECCC GeoMet returned ${response.status}`, "upstream_failure");
      const parsed = input.schema.safeParse(response.body);
      if (!parsed.success)
        throw new EcccProviderError(
          `ECCC GeoMet response failed validation: ${parsed.error.message}`,
        );
      const collection = parsed.data as {
        features: { id: string; properties: { id: string } }[];
        numberMatched: number;
        numberReturned: number;
      };
      const featureIds = new Set<string>();
      if (
        collection.numberReturned !== collection.features.length ||
        collection.numberMatched !== collection.numberReturned ||
        collection.numberMatched > input.limit ||
        collection.features.some((feature) => {
          if (feature.id !== feature.properties.id || featureIds.has(feature.id)) return true;
          featureIds.add(feature.id);
          return false;
        })
      )
        throw new EcccProviderError("ECCC GeoMet response is truncated or internally inconsistent");
      return parsed.data;
    },
    call.signal,
  );
}

function publishedIndex(
  obsId: string,
  kind: "observation" | "forecast",
  value: number,
): PublishedIndexInput {
  const methodId = `eccc-geomet-aqhi-${kind}-method-unspecified`;
  return {
    indexId: indexId({
      observationId: obsId,
      methodId,
      methodRevision: METHOD_REVISION,
      standardId: null,
      standardRevision: null,
    }),
    methodId,
    methodRevision: METHOD_REVISION,
    claimedStandardId: null,
    value,
    displayValue: String(value),
    categoryId: "eccc-published-aqhi-method-unspecified",
    dominantPollutants: [],
  };
}

function evidence(
  query: PointAirQualityQuery,
  feature: Feature,
  kind: "observation" | "forecast",
  distance: number,
): ProviderEvidence | null {
  const properties = feature.properties;
  const isForecast = kind === "forecast";
  const anchor = absolute(
    isForecast
      ? (properties as ForecastFeature["properties"]).forecast_datetime
      : (properties as CurrentFeature["properties"]).observation_datetime,
  );
  const publishedAt = isForecast
    ? absolute((properties as ForecastFeature["properties"]).publication_datetime)
    : null;
  const target = Date.parse(query.evaluatedAt);
  if (
    (!isForecast && Date.parse(anchor) > target) ||
    (publishedAt !== null &&
      (Date.parse(publishedAt) > target || Date.parse(publishedAt) > Date.parse(anchor)))
  )
    return null;
  const spatialSupportId = `ECCC-${properties.location_id}`;
  const obsId = observationId({
    sourceId: SOURCE_ID,
    originRecordId: properties.id,
    spatialSupportId,
    modelRunId: null,
    evaluatedAt: anchor,
  });
  const basis: AirQualityBasis = isForecast ? "model" : "ground";
  return {
    observationId: obsId,
    providerId: "eccc-aqhi",
    sourceIds: [SOURCE_ID],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis,
    originRecords: [{ sourceId: SOURCE_ID, recordId: properties.id }],
    modelRunId: null,
    verticalLevel: null,
    series: [],
    publishedIndices: [publishedIndex(obsId, kind, properties.aqhi)],
    observedAt: isForecast ? null : anchor,
    forecastFor: isForecast ? anchor : null,
    publishedAt,
    validUntil: new Date(
      Date.parse(anchor) + (isForecast ? FORECAST_VALIDITY_MS : CURRENT_VALIDITY_MS),
    ).toISOString(),
    spatial: {
      kind: "community",
      id: spatialSupportId,
      name: properties.location_name_en,
      coordinates: feature.geometry.coordinates,
      timeZone: null,
      distanceMeters: distance,
      stationClass: null,
      mobile: null,
      coversRequestedPoint: false,
      coverageMethod: "nearest-community",
    },
    sources: [source],
  };
}

export function createEcccAirQualityProvider(ctx: IntegrationContext): AirQualityProvider {
  return {
    id: "eccc-aqhi",
    sourceIds: [SOURCE_ID],
    priority: 110,
    timeoutMs: 4_000,
    capabilities: new Set(["current", "forecast", "published-index"]),
    coverage: { countries: ["CA"], bbox: [-141.1, 41.7, -52.5, 83.2] },
    async getCurrent(query, call) {
      if (query.countryCode !== undefined && query.countryCode !== "CA") return [];
      const params = { f: "json", latest: true, limit: CURRENT_LIMIT, bbox: bbox(query) };
      const collection = await fetchCollection(ctx, call, {
        mode: "current",
        endpoint: CURRENT_ENDPOINT,
        params,
        limit: CURRENT_LIMIT,
        maxBytes: 512 * 1_024,
        schema: currentCollectionSchema,
        ttlSeconds: 300,
      });
      const nearest = collection.features
        .map((feature) => ({
          feature,
          distance: distanceMeters(query, feature.geometry.coordinates),
        }))
        .sort(
          (left, right) =>
            left.distance - right.distance || left.feature.id.localeCompare(right.feature.id),
        )[0];
      if (!nearest || nearest.distance > SEARCH_RADIUS_KM * 1_000) return [];
      const item = evidence(query, nearest.feature, "observation", nearest.distance);
      return item ? [item] : [];
    },
    async getForecast(query: ForecastAirQualityQuery, call) {
      if (query.countryCode !== undefined && query.countryCode !== "CA") return [];
      const start = Date.parse(query.evaluatedAt);
      const end = start + query.hours * 60 * 60_000;
      const params = {
        f: "json",
        bbox: bbox(query),
        datetime: `${new Date(start).toISOString()}/${new Date(end).toISOString()}`,
        limit: FORECAST_LIMIT,
      };
      const collection = await fetchCollection(ctx, call, {
        mode: "forecast",
        endpoint: FORECAST_ENDPOINT,
        params,
        limit: FORECAST_LIMIT,
        maxBytes: 4 * 1_024 * 1_024,
        schema: forecastCollectionSchema,
        ttlSeconds: 600,
      });
      const eligible = collection.features.filter((feature) => {
        const forecastAt = Date.parse(feature.properties.forecast_datetime);
        const publishedAt = Date.parse(feature.properties.publication_datetime);
        return (
          forecastAt >= start &&
          forecastAt < end &&
          publishedAt <= start &&
          publishedAt <= forecastAt
        );
      });
      const nearest = eligible
        .map((feature) => ({
          feature,
          distance: distanceMeters(query, feature.geometry.coordinates),
        }))
        .sort(
          (left, right) =>
            left.distance - right.distance || left.feature.id.localeCompare(right.feature.id),
        )[0];
      if (!nearest || nearest.distance > SEARCH_RADIUS_KM * 1_000) return [];
      const byFrame = new Map<string, ForecastFeature>();
      for (const feature of eligible) {
        if (feature.properties.location_id !== nearest.feature.properties.location_id) continue;
        const frame = absolute(feature.properties.forecast_datetime);
        const existing = byFrame.get(frame);
        if (
          !existing ||
          Date.parse(feature.properties.publication_datetime) >
            Date.parse(existing.properties.publication_datetime) ||
          (Date.parse(feature.properties.publication_datetime) ===
            Date.parse(existing.properties.publication_datetime) &&
            feature.id < existing.id)
        )
          byFrame.set(frame, feature);
      }
      return [...byFrame.values()]
        .sort(
          (left, right) =>
            Date.parse(left.properties.forecast_datetime) -
            Date.parse(right.properties.forecast_datetime),
        )
        .flatMap((feature) => {
          const item = evidence(
            query,
            feature,
            "forecast",
            distanceMeters(query, feature.geometry.coordinates),
          );
          return item ? [item] : [];
        });
    },
  };
}
