import { fetchJson as coreFetchJson, createPlace, type Place } from "@openmapx/core";
import {
  type ContributingRecord,
  contributorsForFields,
  createTidesIntegration,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
  type TideCurvePoint,
  type TideEvent,
  type TidesResponse,
  type WaterLevelObservation,
  withContributors,
} from "@openmapx/integration-framework";

/**
 * Canadian tide-prediction + observation knowledge integration. Wraps the
 * DFO IWLS REST API (https://api-iwls.dfo-mpo.gc.ca/) to expose tide events,
 * a 30-min curve, and the latest observed water level for any Canadian
 * place near a CHS station.
 *
 * Values are converted from meters (the IWLS unit) to feet for the shared
 * tide response consumed by `PlaceTidesContent`, and stay above chart datum.
 * The CHS station pages that publish the same series state "Height of tide
 * is the vertical distance between the surface of the sea and chart datum"
 * (https://www.tides.gc.ca/en/stations/07735), and IWLS station metadata
 * lists conversions away from it (`datums: [{ code: "CGVD2013", offset: -2.88 }]`).
 * Timestamps are UTC: "All dates are in ISO 8601 format UTC"
 * (https://api-iwls.dfo-mpo.gc.ca/v3/api-docs).
 *
 * Free + commercial use under Open Government Licence — Canada 2.0.
 *
 * The place-resolver + `/tides` route shell (nearest-station lookup, per-day
 * `nearest:` cache, `{ notFound: true }` sentinel, `Cache-Control`) lives in
 * the shared `createTidesIntegration` factory. Canada additionally feeds the
 * factory an `onWarmNearestHit` hook so warm fast-path hits re-fetch the live
 * `currentLevel` (bypassing `buildTidesResponse`'s canonical 5-min `obs:`
 * refresh would otherwise pin a stale level for the full TIDES_TTL).
 */
const IWLS_BASE = "https://api-iwls.dfo-mpo.gc.ca/api/v1";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 6 * 60 * 60; // 6h — predictions are deterministic
const OBSERVATION_TTL = 5 * 60; // 5 min — observations refresh more often
const MAX_STATION_DISTANCE_KM = 20; // Canadian tide stations are sparse — wider radius than NOAA's 2 km
const M_TO_FT = 3.28084;

interface IwlsTimeSeries {
  code: string; // "wlo" | "wlp" | "wlp-hilo" | "wcs1" | …
  id: string;
}

interface IwlsStationRaw {
  id: string;
  code: string;
  officialName: string;
  alternativeName?: string;
  latitude: number;
  longitude: number;
  operating: boolean;
  timeSeries: IwlsTimeSeries[];
}

interface CachedStation extends ContributingRecord {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  hasWlp: boolean;
  hasHilo: boolean;
  hasWlo: boolean;
}

interface IwlsDataPoint {
  eventDate: string; // ISO UTC, e.g. "2026-05-18T03:20:00Z"
  value: number; // meters
}

export function normalizeIwlsTimestamp(iso: string): string {
  // IWLS returns ISO-8601 UTC like "2026-05-18T03:20:00Z". Keep the `T` and
  // trailing `Z` so the place panel's parser can detect the UTC marker and
  // display the event in the user's browser-local time. Stripping the `Z`
  // made the widget treat the UTC numbers as wall-clock in the browser zone,
  // shifting events by the user's offset and sometimes onto the wrong day.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)Z?/);
  if (!m) return iso;
  return `${m[1]}Z`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  return coreFetchJson<T>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    nullOnError: true,
    headers: { Accept: "application/json" },
  });
}

async function loadStations(ctx: IntegrationContext): Promise<CachedStation[]> {
  const cached = await ctx.cache.get<CachedStation[]>("catalog:contributors-v1");
  if (cached) return cached;
  const captured = resolveIntegrationContributors(ctx, ["dfo-iwls"]);
  // Pull every station that exposes water-level predictions. The IWLS catalog
  // is ~700 stations; `max=2000` covers the entire active set comfortably.
  const raw = await fetchJson<IwlsStationRaw[]>(
    `${IWLS_BASE}/stations?time-series-code=wlp&max=2000`,
  );
  if (!raw) {
    ctx.log.warn("IWLS station catalog unavailable");
    return [];
  }
  const stations: CachedStation[] = raw
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => {
      const codes = new Set(s.timeSeries.map((t) => t.code));
      return {
        id: s.id,
        code: s.code,
        name: s.officialName.trim() || s.code,
        lat: s.latitude,
        lng: s.longitude,
        hasWlp: codes.has("wlp"),
        hasHilo: codes.has("wlp-hilo"),
        hasWlo: codes.has("wlo"),
      };
    });
  const acquired = stations.map((station) => withContributors(station, captured));
  await ctx.cache.set("catalog:contributors-v1", acquired, CATALOG_TTL);
  return acquired;
}

export async function fetchHiloEvents(stationId: string): Promise<TideEvent[]> {
  // 48-hour window starting at today UTC midnight is enough to populate the
  // "today" + "tomorrow" sections of the place-panel widget.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  const fromIso = start.toISOString().replace(/\.\d{3}Z$/, "Z");
  const toIso = end.toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `${IWLS_BASE}/stations/${encodeURIComponent(stationId)}/data?time-series-code=wlp-hilo&from=${fromIso}&to=${toIso}`;
  const raw = await fetchJson<IwlsDataPoint[]>(url);
  if (!raw || raw.length === 0) return [];
  // The IWLS hilo endpoint doesn't tag points as H or L — they alternate
  // chronologically. Tag by comparison with adjacent values: a point is H
  // when its value is greater than the next, else L (with the final point
  // tagged by comparing against the previous).
  const events: TideEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const next = raw[i + 1];
    const prev = raw[i - 1];
    let type: "H" | "L";
    if (next) {
      type = p.value > next.value ? "H" : "L";
    } else if (prev) {
      type = p.value > prev.value ? "H" : "L";
    } else {
      // Only one event — assume high (better default for "next high" UI).
      type = "H";
    }
    events.push({
      time: normalizeIwlsTimestamp(p.eventDate),
      type,
      valueFt: Math.round(p.value * M_TO_FT * 100) / 100,
    });
  }
  return events;
}

export async function fetchCurve(stationId: string): Promise<TideCurvePoint[]> {
  // 30-min sampled curve over the next 24h.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const fromIso = start.toISOString().replace(/\.\d{3}Z$/, "Z");
  const toIso = end.toISOString().replace(/\.\d{3}Z$/, "Z");
  // `resolution=THIRTY_MINUTES` keeps the payload small while preserving curve shape.
  const url = `${IWLS_BASE}/stations/${encodeURIComponent(stationId)}/data?time-series-code=wlp&resolution=THIRTY_MINUTES&from=${fromIso}&to=${toIso}`;
  const raw = await fetchJson<IwlsDataPoint[]>(url);
  if (!raw) return [];
  return raw.map((p) => ({
    time: normalizeIwlsTimestamp(p.eventDate),
    valueFt: Math.round(p.value * M_TO_FT * 100) / 100,
  }));
}

export async function fetchLatestObservation(
  stationId: string,
): Promise<{ time: string; valueFt: number } | null> {
  // Last hour of observed water-level. IWLS returns 1-min resolution; we
  // sample the newest point.
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  const fromIso = start.toISOString().replace(/\.\d{3}Z$/, "Z");
  const toIso = end.toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `${IWLS_BASE}/stations/${encodeURIComponent(stationId)}/data?time-series-code=wlo&from=${fromIso}&to=${toIso}`;
  const raw = await fetchJson<IwlsDataPoint[]>(url);
  if (!raw || raw.length === 0) return null;
  const last = raw[raw.length - 1];
  return {
    time: normalizeIwlsTimestamp(last.eventDate),
    valueFt: Math.round(last.value * M_TO_FT * 100) / 100,
  };
}

/**
 * Read the 5-min `obs:` cache for a station, refreshing from upstream on miss.
 * Shared so both the cold prediction-build path and the warm fast-path can
 * keep `currentLevel` honest. Passive cache reads alone leave the warm path
 * with whatever observation was cached at build time — once the obs entry
 * expires the prediction response would pin a stale level for the full
 * TIDES_TTL.
 */
type CapturedObservation = WaterLevelObservation & ContributingRecord;

async function refreshCurrentLevel(
  ctx: IntegrationContext,
  stationId: string,
  hasWlo: boolean,
): Promise<CapturedObservation | undefined> {
  if (!hasWlo) return undefined;
  const obsKey = `obs:contributors-v1:${stationId}`;
  const cached = await ctx.cache.get<CapturedObservation | { notFound: true }>(obsKey);
  if (cached) return "notFound" in cached ? undefined : cached;
  const captured = resolveIntegrationContributors(ctx, ["dfo-iwls"]);
  const fetched = await fetchLatestObservation(stationId);
  const observed = fetched ? withContributors(fetched, captured) : undefined;
  await ctx.cache.set(obsKey, observed ?? ({ notFound: true } as const), OBSERVATION_TTL);
  return observed;
}

/** Replace only the live observation and its ownership, retaining prediction snapshots. */
function withCurrentLevel(
  payload: TidesResponse,
  observation: CapturedObservation | undefined,
): TidesResponse {
  const fieldContributors = {
    ...payload.fieldContributors,
    currentLevel: snapshotContributors(observation?.contributors ?? []),
  };
  return withContributors(
    {
      ...payload,
      currentLevel: observation
        ? { time: observation.time, valueFt: observation.valueFt }
        : undefined,
      fieldContributors,
    },
    contributorsForFields(fieldContributors, Object.keys(fieldContributors)),
  );
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const dayKey = new Date().toISOString().slice(0, 10);
  // High/low events + curve are deterministic; cache 6h.
  const cacheKey = `tides:datum-v1:${station.id}:${dayKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) {
    return station.hasWlo
      ? withCurrentLevel(cached, await refreshCurrentLevel(ctx, station.id, true))
      : withContributors(cached, cached.contributors ?? []);
  }

  const captured = resolveIntegrationContributors(ctx, ["dfo-iwls"]);
  const [events, curve] = await Promise.all([fetchHiloEvents(station.id), fetchCurve(station.id)]);
  if (events.length === 0 && curve.length === 0) return null;

  const currentLevel = await refreshCurrentLevel(ctx, station.id, station.hasWlo);

  const result: TidesResponse = {
    contributors: snapshotContributors(station.contributors ?? [], captured),
    fieldContributors: {
      station: snapshotContributors(station.contributors ?? []),
      events: snapshotContributors(captured),
      curve: snapshotContributors(captured),
    },
    station: {
      id: station.id,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      distanceKm: Number(distanceKm.toFixed(2)),
    },
    events,
    curve,
    datum: "chart_datum",
    units: "english",
    timeZone: "iso_offset",
    currentLevel,
  };
  const acquired = station.hasWlo ? withCurrentLevel(result, currentLevel) : result;
  await ctx.cache.set(cacheKey, acquired, TIDES_TTL);
  return acquired;
}

export function setup(ctx: IntegrationContext): void {
  createTidesIntegration<CachedStation>(ctx, {
    scheme: "ca-iwls",
    sourceId: "dfo-iwls",
    loadStations,
    findStationById: (stations, id) => stations.find((s) => s.id === id || s.code === id),
    createPlace: (station, resolveCtx): Place => {
      const place: Place = createPlace({
        primaryScheme: "ca-iwls",
        ids: { "ca-iwls": station.id },
        name: station.name,
        contributors: snapshotContributors(station.contributors ?? []),
        address: "",
        countryCode: "ca",
        coordinates: [station.lng, station.lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      });
      void resolveCtx;
      return place;
    },
    buildTidesResponse,
    maxStationDistanceKm: MAX_STATION_DISTANCE_KM,
    nearestCacheTtl: TIDES_TTL,
    cacheControlMaxAge: 3600,
    unavailableMessage: "Tide predictions unavailable",
    onWarmNearestHit: async (hookCtx, cached) => {
      // An owned currentLevel key records observation support even when the
      // latest request returned no reading. A future refresh may restore it.
      if (cached.fieldContributors && Object.hasOwn(cached.fieldContributors, "currentLevel")) {
        Object.assign(
          cached,
          withCurrentLevel(cached, await refreshCurrentLevel(hookCtx, cached.station.id, true)),
        );
      }
    },
  });
}
