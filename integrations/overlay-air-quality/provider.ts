import type {
  AirQualityUnit,
  Pollutant,
  PollutantSeries,
  ProviderEvidence,
} from "@openmapx/air-quality";
import { deriveCoherenceKey } from "@openmapx/air-quality";
import { observationId } from "@openmapx/air-quality/ids";
import type {
  AirQualityProvider,
  IntegrationContext,
  PointAirQualityQuery,
  ProviderCallContext,
  StationViewportQuery,
} from "@openmapx/integration-framework";
import { mapSettledWithConcurrency } from "@openmapx/integration-framework";
import {
  loadOpenAQCached,
  OPENAQ_METADATA_TTL,
  OPENAQ_SERIES_TTL,
  OpenAQCacheUnavailableError,
} from "./cache-policy.js";
import { type OpenAQClient, OpenAQClientError, type OpenAQPage } from "./openaq-client.js";
import type { OpenAQHour, OpenAQLatest, OpenAQLocation, OpenAQParameter } from "./schemas.js";
import { rankStationDemand } from "./station-demand.js";

const PROVIDER_ID = "openaq";
const SOURCE_ID = "openaq";
const SCHEMA_REVISION = "openaq-v3-openapi-3.0.0";
const SERIES_REVISION = "openmapx-openaq-series-v1";
const POINT_RADIUS_METERS = 25_000;
const MAX_POINT_LOCATIONS = 4;
const MAX_POINT_SENSORS = 8;
const QUERY_POLLUTANTS: readonly Pollutant[] = ["pm25", "pm10", "o3", "no2", "so2", "co", "no"];

const supportedPollutants = new Set<Pollutant>([
  "pm25",
  "pm10",
  "o3",
  "no2",
  "so2",
  "co",
  "nh3",
  "no",
]);

function pollutant(parameter: OpenAQParameter): Pollutant | null {
  const value = parameter.name.toLowerCase().replaceAll(".", "");
  if (value === "pm25") return "pm25";
  return supportedPollutants.has(value as Pollutant) ? (value as Pollutant) : null;
}

function unit(value: string): AirQualityUnit | null {
  const normalized = value
    .toLowerCase()
    .replaceAll("μ", "u")
    .replaceAll("µ", "u")
    .replaceAll("³", "3")
    .replaceAll(" ", "");
  if (["ug/m3", "ugm-3", "ugm3"].includes(normalized)) return "ug/m3";
  if (["mg/m3", "mgm-3", "mgm3"].includes(normalized)) return "mg/m3";
  if (normalized === "ppb") return "ppb";
  if (normalized === "ppm") return "ppm";
  return null;
}

function stationClass(location: OpenAQLocation): ProviderEvidence["spatial"]["stationClass"] {
  if (location.isMobile) return "unknown";
  if (location.isMonitor) return "reference";
  const instruments = location.instruments.map((item) => item.name).join(" ");
  return /\b(purpleair|airgradient|clarity node)\b/i.test(instruments) ? "low-cost" : "unknown";
}

function activeLicense(location: OpenAQLocation, observedAt: string | null) {
  const date = observedAt?.slice(0, 10) ?? null;
  return (
    location.licenses?.find(
      (license) =>
        (date === null || !license.dateFrom || license.dateFrom <= date) &&
        (date === null || !license.dateTo || license.dateTo >= date),
    ) ??
    location.licenses?.[0] ??
    null
  );
}

function coordinateTuple(location: OpenAQLocation): [number, number] | null {
  const latitude = location.coordinates.latitude;
  const longitude = location.coordinates.longitude;
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
    ? [longitude, latitude]
    : null;
}

function interval(hour: OpenAQHour): { startAt: string; endAt: string } | null {
  const startAt = hour.period?.datetimeFrom?.utc;
  const endAt = hour.period?.datetimeTo?.utc;
  if (
    !startAt ||
    !endAt ||
    !Number.isFinite(Date.parse(startAt)) ||
    !Number.isFinite(Date.parse(endAt)) ||
    Date.parse(startAt) >= Date.parse(endAt)
  )
    return null;
  return { startAt, endAt };
}

function seriesFromHours(
  location: OpenAQLocation,
  input: { sensor: OpenAQLocation["sensors"][number]; hours: readonly OpenAQHour[] },
): PollutantSeries | null {
  const mappedPollutant = pollutant(input.sensor.parameter);
  const mappedUnit = unit(input.sensor.parameter.units);
  if (!mappedPollutant || !mappedUnit) return null;
  const spatialSupportId = `openaq-location-${location.id}`;
  const coherenceKey = deriveCoherenceKey({
    basis: "ground",
    providerId: PROVIDER_ID,
    providerLocationId: String(location.id),
    spatialSupportId,
  });
  const samples = input.hours.flatMap((hour) => {
    const dates = interval(hour);
    const hourUnit = unit(hour.parameter.units);
    if (
      !dates ||
      pollutant(hour.parameter) !== mappedPollutant ||
      hourUnit !== mappedUnit ||
      hour.value === null ||
      hour.value === undefined
    )
      return [];
    return [
      {
        ...dates,
        value: hour.value,
        unit: mappedUnit,
        valid: !hour.flagInfo.hasFlags && Number.isFinite(hour.value) && hour.value >= 0,
        estimated: false,
        gapFilled: false,
      },
    ];
  });
  if (samples.length === 0) return null;
  samples.sort((left, right) => Date.parse(left.endAt) - Date.parse(right.endAt));
  return {
    seriesId: `openaq:location:${location.id}:sensor:${input.sensor.id}:${SERIES_REVISION}`,
    coherenceKey,
    pollutant: mappedPollutant,
    sensorId: String(input.sensor.id),
    spatialSupportId,
    cadenceMinutes: 60,
    originalUnit: input.sensor.parameter.units,
    samples,
  };
}

function evidenceFromSeries(
  location: OpenAQLocation,
  series: PollutantSeries[],
  options: {
    requestedPoint?: readonly [number, number];
    licenseUrls?: ReadonlyMap<number, string>;
  } = {},
): ProviderEvidence | null {
  const coordinates = coordinateTuple(location);
  if (!coordinates || series.length === 0) return null;
  const allEnds = series.flatMap((item) => item.samples.map((sample) => sample.endAt));
  const observedAt = allEnds.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const license = activeLicense(location, observedAt);
  const spatialSupportId = `openaq-location-${location.id}`;
  const originRecords = series.flatMap((item) =>
    item.samples.map((sample) => ({
      sourceId: SOURCE_ID,
      recordId: `location:${location.id}:sensor:${item.sensorId}:${sample.endAt}`,
    })),
  );
  const firstRecord = originRecords[0]?.recordId ?? `location:${location.id}`;
  return {
    observationId: observationId({
      sourceId: SOURCE_ID,
      originRecordId: firstRecord,
      spatialSupportId,
      modelRunId: null,
      evaluatedAt: observedAt ?? new Date(0).toISOString(),
    }),
    providerId: PROVIDER_ID,
    sourceIds: [SOURCE_ID],
    dataAuthority: "aggregator",
    qualityStatus: stationClass(location) === "low-cost" ? "unknown" : "preliminary",
    basis: "ground",
    originRecords,
    modelRunId: null,
    verticalLevel: null,
    series,
    publishedIndices: [],
    observedAt,
    forecastFor: null,
    publishedAt: null,
    validUntil: null,
    spatial: {
      kind: "station",
      id: spatialSupportId,
      name: location.name,
      coordinates,
      timeZone: location.timezone,
      distanceMeters: location.distance ?? null,
      stationClass: stationClass(location),
      mobile: location.isMobile,
      coversRequestedPoint: options.requestedPoint !== undefined || location.distance !== null,
      coverageMethod: "nearest-station",
    },
    sources: [
      {
        sourceId: SOURCE_ID,
        name: `OpenAQ via ${location.provider.name}`,
        url: license?.attribution.url ?? null,
        owner: location.owner.name,
        license: license
          ? { name: license.name, url: options.licenseUrls?.get(license.id) ?? null }
          : null,
        methodologyUrl: "https://docs.openaq.org/resources/measurements",
        attribution: license?.attribution.name ?? location.owner.name,
      },
    ],
  };
}

export function buildOpenAQEvidence(
  location: OpenAQLocation,
  inputs: readonly { sensor: OpenAQLocation["sensors"][number]; hours: readonly OpenAQHour[] }[],
  options: {
    requestedPoint?: readonly [number, number];
    licenseUrls?: ReadonlyMap<number, string>;
  } = {},
): ProviderEvidence | null {
  const series = inputs.flatMap((input) => {
    const item = seriesFromHours(location, input);
    return item ? [item] : [];
  });
  return evidenceFromSeries(location, series, options);
}

function buildLatestEvidence(
  location: OpenAQLocation,
  sensor: OpenAQLocation["sensors"][number],
  latest: OpenAQLatest,
  licenseUrls: ReadonlyMap<number, string>,
): ProviderEvidence | null {
  const mappedPollutant = pollutant(sensor.parameter);
  const mappedUnit = unit(sensor.parameter.units);
  if (!mappedPollutant || !mappedUnit || !Number.isFinite(latest.value) || latest.value < 0)
    return null;
  const end = Date.parse(latest.datetime.utc);
  if (!Number.isFinite(end)) return null;
  const spatialSupportId = `openaq-location-${location.id}`;
  const series: PollutantSeries = {
    seriesId: `openaq:location:${location.id}:sensor:${sensor.id}:latest:${SERIES_REVISION}`,
    coherenceKey: deriveCoherenceKey({
      basis: "ground",
      providerId: PROVIDER_ID,
      providerLocationId: String(location.id),
      spatialSupportId,
    }),
    pollutant: mappedPollutant,
    sensorId: String(sensor.id),
    spatialSupportId,
    cadenceMinutes: null,
    originalUnit: sensor.parameter.units,
    samples: [
      {
        startAt: new Date(end - 1).toISOString(),
        endAt: new Date(end).toISOString(),
        value: latest.value,
        unit: mappedUnit,
        valid: true,
        estimated: false,
        gapFilled: false,
      },
    ],
  };
  return evidenceFromSeries(location, [series], { licenseUrls });
}

function spatialKey(latitude: number, longitude: number): string {
  return `${Math.round(latitude * 100) / 100},${Math.round(longitude * 100) / 100}`;
}

function bboxKey(query: StationViewportQuery): string {
  const round = (value: number) => (Math.round(value * 10_000) / 10_000).toFixed(4);
  return [query.west, query.south, query.east, query.north].map(round).join(",");
}

export function createOpenAQProvider(
  ctx: IntegrationContext,
  client: OpenAQClient,
): AirQualityProvider {
  async function cached<T>(
    key: string,
    kind: "metadata" | "series",
    signal: AbortSignal,
    refresh: () => Promise<T>,
  ): Promise<T> {
    if (!ctx.upstreamRuntime) return refresh();
    try {
      return (
        await loadOpenAQCached({
          runtime: ctx.upstreamRuntime,
          key: `${PROVIDER_ID}:${SCHEMA_REVISION}:${SERIES_REVISION}:${key}`,
          ttl: kind === "metadata" ? OPENAQ_METADATA_TTL : OPENAQ_SERIES_TTL,
          signal,
          refresh,
        })
      ).value;
    } catch (error) {
      if (error instanceof OpenAQCacheUnavailableError)
        throw new OpenAQClientError("quota_exhausted", error.message);
      throw error;
    }
  }

  async function loadLicenseUrls(signal: AbortSignal): Promise<ReadonlyMap<number, string>> {
    try {
      const catalog = await cached("licenses", "metadata", signal, () =>
        client.listLicenses(signal),
      );
      return new Map(catalog.items.map((license) => [license.id, license.sourceUrl]));
    } catch (error) {
      if (signal.aborted) throw error;
      ctx.log.warn(
        "OpenAQ license catalog unavailable; retaining license names without terms URLs",
      );
      return new Map();
    }
  }

  async function current(
    query: PointAirQualityQuery,
    call: ProviderCallContext,
  ): Promise<ProviderEvidence[]> {
    const evaluatedAt = Date.parse(query.evaluatedAt);
    if (!Number.isFinite(evaluatedAt))
      throw new OpenAQClientError("invalid_request", "Evaluation time must be a valid instant");
    const to = new Date(Math.floor(evaluatedAt / 3_600_000) * 3_600_000).toISOString();
    const from = new Date(Date.parse(to) - 48 * 3_600_000).toISOString();
    const locations = await cached(
      `locations:point:${spatialKey(query.latitude, query.longitude)}`,
      "metadata",
      call.signal,
      () =>
        client.listLocations(
          {
            point: {
              latitude: query.latitude,
              longitude: query.longitude,
              radiusMeters: POINT_RADIUS_METERS,
            },
            pollutants: QUERY_POLLUTANTS,
            maxPages: 2,
            pageSize: 100,
          },
          call.signal,
        ),
    );
    const selected = rankStationDemand(locations.items, {
      zoom: 12,
      limit: MAX_POINT_LOCATIONS,
    }).selected;
    if (selected.length === 0) return [];
    const licenseUrls = await loadLicenseUrls(call.signal);
    const output: ProviderEvidence[] = [];
    let quotaFailure: OpenAQClientError | null = null;
    let firstFailure: unknown = null;
    for (const location of selected) {
      if (call.signal.aborted)
        throw call.signal.reason ?? new DOMException("Aborted", "AbortError");
      let latest: OpenAQPage<OpenAQLatest>;
      try {
        latest = await cached(`latest:${location.id}`, "series", call.signal, () =>
          client.getLatest(location.id, call.signal),
        );
      } catch (error) {
        if (call.signal.aborted) throw call.signal.reason ?? error;
        if (error instanceof OpenAQClientError && error.code === "quota_exhausted") {
          quotaFailure ??= error;
          continue;
        }
        firstFailure ??= error;
        continue;
      }
      const active = new Set(latest.items.map((item) => item.sensorsId));
      const sensors = location.sensors
        .filter((sensor) => active.has(sensor.id) && pollutant(sensor.parameter) !== null)
        .slice(0, MAX_POINT_SENSORS);
      const settled = await mapSettledWithConcurrency(sensors, 4, async (sensor) => ({
        sensor,
        hours: (
          await cached(`hours:${sensor.id}:${from}:${to}`, "series", call.signal, () =>
            client.getSensorHours(sensor.id, { from, to, maxSamples: 48 }, call.signal),
          )
        ).items,
      }));
      if (call.signal.aborted)
        throw call.signal.reason ?? new DOMException("Aborted", "AbortError");
      for (const item of settled) {
        if (item.status !== "rejected") continue;
        if (item.reason instanceof OpenAQClientError && item.reason.code === "quota_exhausted")
          quotaFailure ??= item.reason;
        else firstFailure ??= item.reason;
      }
      const evidence = buildOpenAQEvidence(
        location,
        settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : [])),
        { requestedPoint: [query.latitude, query.longitude], licenseUrls },
      );
      if (evidence) output.push(evidence);
    }
    if (output.length === 0 && firstFailure) throw firstFailure;
    if (output.length === 0 && quotaFailure) throw quotaFailure;
    return output;
  }

  async function stations(query: StationViewportQuery, call: ProviderCallContext) {
    const locations = await cached(
      `locations:bbox:${bboxKey(query)}:${query.pollutant}`,
      "metadata",
      call.signal,
      () =>
        client.listLocations(
          {
            bbox: [query.west, query.south, query.east, query.north],
            pollutants: [query.pollutant],
            maxPages: 5,
            pageSize: 100,
          },
          call.signal,
        ),
    );
    const demand = rankStationDemand(locations.items, {
      zoom: query.zoom,
      limit: Math.min(query.limit, 100),
    });
    const licenseUrls =
      demand.selected.length > 0 ? await loadLicenseUrls(call.signal) : new Map<number, string>();
    const settled = await mapSettledWithConcurrency(demand.selected, 5, async (location) => {
      const latest = await cached(`latest:${location.id}`, "series", call.signal, () =>
        client.getLatest(location.id, call.signal),
      );
      const candidates = latest.items
        .map((item) => ({
          item,
          sensor: location.sensors.find((sensor) => sensor.id === item.sensorsId),
        }))
        .filter(
          (item): item is { item: OpenAQLatest; sensor: OpenAQLocation["sensors"][number] } =>
            item.sensor !== undefined && pollutant(item.sensor.parameter) === query.pollutant,
        )
        .sort(
          (left, right) =>
            Date.parse(right.item.datetime.utc) - Date.parse(left.item.datetime.utc) ||
            left.sensor.id - right.sensor.id,
        );
      return candidates[0]
        ? buildLatestEvidence(location, candidates[0].sensor, candidates[0].item, licenseUrls)
        : null;
    });
    const evidence = settled.flatMap((item) =>
      item.status === "fulfilled" && item.value ? [item.value] : [],
    );
    const skippedByFailure = settled.filter((item) => item.status === "rejected").length;
    const quotaDeniedCount = settled.filter(
      (item) =>
        item.status === "rejected" &&
        item.reason instanceof OpenAQClientError &&
        item.reason.code === "quota_exhausted",
    ).length;
    if (evidence.length === 0 && quotaDeniedCount > 0)
      throw new OpenAQClientError(
        "quota_exhausted",
        "OpenAQ quota prevented all station refreshes",
      );
    return {
      evidence,
      nextCursor: null,
      truncated: locations.truncated || demand.diagnostics.skippedCount > 0 || skippedByFailure > 0,
      diagnostics: {
        candidateCount: demand.diagnostics.candidateCount,
        servedCount: evidence.length,
        skippedCount: demand.diagnostics.candidateCount - evidence.length,
        quotaDeniedCount,
        failureCount: skippedByFailure - quotaDeniedCount,
      },
    };
  }

  return {
    id: PROVIDER_ID,
    sourceIds: [SOURCE_ID],
    priority: 20,
    timeoutMs: 3_000,
    capabilities: new Set(["current", "stations", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    getCurrent: current,
    getStations: stations,
  };
}
