import { createHash } from "node:crypto";

import type {
  AirQualitySourceRef,
  Pollutant,
  PollutantSeries,
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
  UpstreamCacheTtl,
} from "@openmapx/integration-framework";

import {
  type OpenMeteoAirQualityResponse,
  openMeteoAirQualityResponseSchema,
  openMeteoVariables,
} from "./schemas.js";

const ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const SOURCE_ID = "open-meteo-air-quality";
const PROVIDER_REVISION = "open-meteo-air-quality-v1";
const CURRENT_TTL: UpstreamCacheTtl = {
  softMs: 15 * 60_000,
  hardMs: 60 * 60_000,
  staleIfErrorMs: 3 * 60 * 60_000,
};
const FORECAST_TTL: UpstreamCacheTtl = {
  softMs: 30 * 60_000,
  hardMs: 2 * 60 * 60_000,
  staleIfErrorMs: 6 * 60 * 60_000,
};

const source: AirQualitySourceRef = {
  sourceId: SOURCE_ID,
  name: "Open-Meteo Air Quality API / CAMS",
  url: "https://open-meteo.com/en/docs/air-quality-api",
  owner: "Open-Meteo and Copernicus Atmosphere Monitoring Service",
  license: {
    name: "CC BY 4.0; Open-Meteo plan terms apply",
    url: "https://open-meteo.com/en/terms",
  },
  methodologyUrl: "https://open-meteo.com/en/docs/air-quality-api",
  attribution: "Open-Meteo; CAMS ENSEMBLE data providers",
};

const pollutants: ReadonlyArray<{
  field: "pm10" | "pm2_5" | "carbon_monoxide" | "nitrogen_dioxide" | "sulphur_dioxide" | "ozone";
  pollutant: Pollutant;
}> = [
  { field: "pm10", pollutant: "pm10" },
  { field: "pm2_5", pollutant: "pm25" },
  { field: "carbon_monoxide", pollutant: "co" },
  { field: "nitrogen_dioxide", pollutant: "no2" },
  { field: "sulphur_dioxide", pollutant: "so2" },
  { field: "ozone", pollutant: "o3" },
];

export class OpenMeteoProviderError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_response" | "upstream_failure",
  ) {
    super(message);
    this.name = "OpenMeteoProviderError";
  }
}

function absoluteTime(value: string): string {
  const candidate = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed))
    throw new OpenMeteoProviderError("Invalid Open-Meteo time", "invalid_response");
  return new Date(parsed).toISOString();
}

function cacheKey(
  mode: "current" | "forecast",
  query: PointAirQualityQuery,
  hours: number,
): string {
  const cell = {
    latitude: Math.round(query.latitude * 100) / 100,
    longitude: Math.round(query.longitude * 100) / 100,
    hours,
  };
  const digest = createHash("sha256").update(JSON.stringify(cell)).digest("base64url");
  return `open-meteo-air-quality:${mode}:v1:${digest}`;
}

async function fetchResponse(
  ctx: IntegrationContext,
  query: PointAirQualityQuery,
  hours: number,
  call: ProviderCallContext,
): Promise<OpenMeteoAirQualityResponse> {
  const response = await ctx.http.getResponse<unknown>(ENDPOINT, {
    params: {
      latitude: query.latitude,
      longitude: query.longitude,
      current: openMeteoVariables.join(","),
      hourly: openMeteoVariables.join(","),
      past_hours: 24,
      forecast_hours: hours,
      timezone: "GMT",
      cell_selection: "nearest",
    },
    signal: call.signal,
    timeoutMs: Math.max(250, call.deadlineAt - Date.now()),
    maxBytes: 512 * 1_024,
    contentTypes: ["application/json"],
    redirect: "error",
  });
  if (response.status < 200 || response.status >= 300)
    throw new OpenMeteoProviderError(`Open-Meteo returned ${response.status}`, "upstream_failure");
  const parsed = openMeteoAirQualityResponseSchema.safeParse(response.body);
  if (!parsed.success)
    throw new OpenMeteoProviderError(
      `Open-Meteo response failed validation: ${parsed.error.message}`,
      "invalid_response",
    );
  return parsed.data;
}

async function cachedResponse(
  ctx: IntegrationContext,
  mode: "current" | "forecast",
  query: PointAirQualityQuery,
  hours: number,
  call: ProviderCallContext,
): Promise<OpenMeteoAirQualityResponse> {
  const runtime = ctx.upstreamRuntime;
  const key = cacheKey(mode, query, hours);
  const cached = await runtime
    ?.read<unknown>(key)
    .catch(() => ({ state: "miss" as const, diagnostic: "store_unavailable" as const }));
  const cachedValue =
    cached && cached.state !== "miss"
      ? openMeteoAirQualityResponseSchema.safeParse(cached.value)
      : null;
  if (cached?.state === "fresh" && cachedValue?.success) return cachedValue.data;
  if (cached?.state === "stale" && cachedValue?.success) {
    const lease = await runtime?.acquireLease(`refresh:${key}`, 15_000).catch(() => null);
    if (lease) {
      void fetchResponse(ctx, query, hours, call)
        .then((result) =>
          runtime?.write(key, result, mode === "current" ? CURRENT_TTL : FORECAST_TTL),
        )
        .catch(() => undefined)
        .finally(() => runtime?.releaseLease(`refresh:${key}`, lease.token).catch(() => undefined));
    }
    return cachedValue.data;
  }
  try {
    const result = await fetchResponse(ctx, query, hours, call);
    await runtime
      ?.write(key, result, mode === "current" ? CURRENT_TTL : FORECAST_TTL)
      .catch(() => undefined);
    return result;
  } catch (error) {
    if (cached?.state === "stale-if-error" && cachedValue?.success) return cachedValue.data;
    throw error;
  }
}

function distanceMeters(query: PointAirQualityQuery, data: OpenMeteoAirQualityResponse): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(data.latitude - query.latitude);
  const dLng = radians(data.longitude - query.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(query.latitude)) * Math.cos(radians(data.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function cadenceMinutes(data: OpenMeteoAirQualityResponse): number {
  const instants = data.hourly.time.map((value) => Date.parse(absoluteTime(value)));
  const differences = instants
    .slice(1)
    .map((instant, index) => instant - (instants[index] ?? instant));
  const cadence = differences[0];
  if (
    cadence === undefined ||
    cadence <= 0 ||
    cadence % 60_000 !== 0 ||
    differences.some((difference) => difference !== cadence)
  )
    throw new OpenMeteoProviderError(
      "Open-Meteo hourly time axis has no uniform declared cadence",
      "invalid_response",
    );
  return cadence / 60_000;
}

function seriesFor(
  data: OpenMeteoAirQualityResponse,
  through: number,
  spatialSupportId: string,
): PollutantSeries[] {
  const cadence = cadenceMinutes(data);
  return pollutants.flatMap(({ field, pollutant }): PollutantSeries[] => {
    const samples = data.hourly.time.flatMap((rawTime, position) => {
      const endAt = absoluteTime(rawTime);
      const end = Date.parse(endAt);
      const value = data.hourly[field][position];
      if (end > through || value === null || value === undefined) return [];
      return [
        {
          startAt: new Date(end - cadence * 60_000).toISOString(),
          endAt,
          value,
          unit: "ug/m3" as const,
          valid: true,
          estimated: true,
          gapFilled: false,
        },
      ];
    });
    if (samples.length === 0) return [];
    return [
      {
        seriesId: `${spatialSupportId}:${pollutant}`,
        coherenceKey: spatialSupportId,
        pollutant,
        sensorId: null,
        spatialSupportId,
        cadenceMinutes: cadence,
        originalUnit: data.hourly_units[field],
        samples,
      },
    ];
  });
}

function nativeIndex(
  obsId: string,
  methodId: "open-meteo-us-aqi" | "open-meteo-european-aqi",
  value: number | null,
): PublishedIndexInput {
  return {
    indexId: indexId({
      observationId: obsId,
      methodId,
      methodRevision: PROVIDER_REVISION,
      standardId: null,
      standardRevision: null,
    }),
    methodId,
    methodRevision: PROVIDER_REVISION,
    claimedStandardId: null,
    value,
    displayValue: value === null ? "" : String(value),
    categoryId:
      value === null ? "provider-native-unavailable" : `provider-native-${Math.floor(value)}`,
    dominantPollutants: [],
  };
}

function evidence(
  query: PointAirQualityQuery,
  data: OpenMeteoAirQualityResponse,
  target: string,
  kind: "current" | "forecast",
  position?: number,
): ProviderEvidence | null {
  const targetAt = absoluteTime(target);
  const gridId = `open-meteo-cams-grid:${data.latitude.toFixed(4)},${data.longitude.toFixed(4)}`;
  const obsId = observationId({
    sourceId: SOURCE_ID,
    originRecordId: `${gridId}:${kind}:${targetAt}`,
    spatialSupportId: gridId,
    modelRunId: null,
    evaluatedAt: targetAt,
  });
  const series = seriesFor(data, Date.parse(targetAt), gridId);
  if (series.length === 0) return null;
  const cadence = cadenceMinutes(data);
  const european =
    position === undefined
      ? data.current.european_aqi
      : (data.hourly.european_aqi[position] ?? null);
  const us = position === undefined ? data.current.us_aqi : (data.hourly.us_aqi[position] ?? null);
  return {
    observationId: obsId,
    providerId: "open-meteo-air-quality",
    sourceIds: [SOURCE_ID],
    dataAuthority: "aggregator",
    qualityStatus: "estimated",
    basis: "model",
    originRecords: [{ sourceId: SOURCE_ID, recordId: `${gridId}:${kind}:${targetAt}` }],
    modelRunId: null,
    verticalLevel: "near-surface (approximately 10 m for pollutants)",
    series,
    publishedIndices: [
      nativeIndex(obsId, "open-meteo-european-aqi", european),
      nativeIndex(obsId, "open-meteo-us-aqi", us),
    ],
    observedAt: kind === "current" ? targetAt : null,
    forecastFor: kind === "forecast" ? targetAt : null,
    publishedAt: null,
    validUntil: new Date(Date.parse(targetAt) + cadence * 60_000).toISOString(),
    spatial: {
      kind: "grid-cell",
      id: gridId,
      name: "Open-Meteo CAMS grid cell",
      coordinates: [data.longitude, data.latitude],
      timeZone: data.timezone,
      distanceMeters: distanceMeters(query, data),
      stationClass: null,
      mobile: null,
      coversRequestedPoint: true,
      coverageMethod: "provider-point-lookup",
    },
    sources: [source],
  };
}

export function createOpenMeteoAirQualityProvider(ctx: IntegrationContext): AirQualityProvider {
  return {
    id: "open-meteo-air-quality",
    sourceIds: [SOURCE_ID],
    priority: 500,
    timeoutMs: 3_000,
    capabilities: new Set(["current", "forecast", "pollutants", "published-index"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    async getCurrent(query, call) {
      const data = await cachedResponse(ctx, "current", query, 1, call);
      const item = evidence(query, data, data.current.time, "current");
      return item ? [item] : [];
    },
    async getForecast(query: ForecastAirQualityQuery, call) {
      const data = await cachedResponse(ctx, "forecast", query, query.hours, call);
      const start = Date.parse(query.evaluatedAt);
      const end = start + query.hours * 60 * 60_000;
      return data.hourly.time.flatMap((time, position) => {
        const instant = Date.parse(absoluteTime(time));
        if (instant < start || instant >= end) return [];
        const item = evidence(query, data, time, "forecast", position);
        return item ? [item] : [];
      });
    },
  };
}

export async function getOpenMeteoLegacyCurrent(
  ctx: IntegrationContext,
  query: PointAirQualityQuery,
  call: ProviderCallContext,
) {
  const data = await cachedResponse(ctx, "current", query, 1, call);
  return {
    pm25: data.current.pm2_5,
    pm10: data.current.pm10,
    no2: data.current.nitrogen_dioxide,
    o3: data.current.ozone,
    so2: data.current.sulphur_dioxide,
    co: data.current.carbon_monoxide,
    europeanAqi: data.current.european_aqi,
    usAqi: data.current.us_aqi,
    time: data.current.time,
  };
}
