import {
  fetchJson as coreFetchJson,
  createPlace,
  despikeSeries,
  findTideExtrema,
  type Place,
} from "@openmapx/core";
import { createTidesIntegration, type IntegrationContext } from "@openmapx/integration-framework";

/**
 * Global tide-gauge observation knowledge integration. Wraps the IOC Sea
 * Level Station Monitoring Facility (UNESCO):
 *
 *  - `service.php?query=stationlist&format=json` — ~700 active gauges worldwide
 *  - `service.php?query=data&code=<station>&period=<days>` — observations
 *
 * IOC publishes observations only (no harmonic predictions). The integration
 * still emits a TidesResponse so the existing `PlaceTidesContent` widget
 * renders: current level + curve + derived high/low events from the past
 * 24 h of observations. Forecast event sections self-hide because the
 * derived events all lie in the past.
 *
 * Units: m by default; converted to feet for parity with NOAA. Free +
 * commercial use under UNESCO-IOC public-data policy.
 *
 * The place-resolver + `/tides` route shell (nearest-station lookup, per-day
 * `nearest:` cache, `{ notFound: true }` sentinel, `Cache-Control`) lives in
 * the shared `createTidesIntegration` factory; everything below is the
 * IOC-specific catalog/observation handling.
 */
const BASE = "http://www.ioc-sealevelmonitoring.org/service.php";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 30 * 60; // observations refresh; predictions cache shorter
const MAX_STATION_DISTANCE_KM = 80; // IOC stations are sparse globally
const M_TO_FT = 3.28084;

interface IocStationRaw {
  Code: string;
  Location: string;
  country?: string;
  Lat: number;
  Lon: number;
  status?: number;
  units?: string; // "M" or "F" depending on sensor
}

interface IocDataPoint {
  slevel: number;
  stime: string; // "2026-05-17 22:30:00"
  sensor: string;
}

interface CachedStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
  country?: string;
}

interface TideEvent {
  time: string;
  type: "H" | "L";
  valueFt: number;
}

interface TidesResponse {
  station: { id: string; name: string; lat: number; lng: number; distanceKm: number };
  events: TideEvent[];
  curve: Array<{ time: string; valueFt: number }>;
  datum: "MLLW";
  units: "english";
  timeZone: "lst_ldt";
  currentLevel?: { time: string; valueFt: number };
}

function reformatIocTime(stime: string): string {
  // IOC publishes `stime` in UTC without a TZ marker (e.g. "2026-05-17 22:30:00").
  // Convert to ISO-8601 with `Z` so the place-panel parser detects UTC and
  // renders the event in the viewer's browser-local zone. Returning the
  // space-separated form would land in the wall-clock branch and shift events
  // by the viewer's UTC offset.
  const m = stime.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return stime;
  return `${m[1]}T${m[2]}Z`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  return coreFetchJson<T>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    nullOnError: true,
    headers: { Accept: "application/json" },
  });
}

async function loadStations(ctx: IntegrationContext): Promise<CachedStation[]> {
  const cached = await ctx.cache.get<CachedStation[]>("catalog");
  if (cached) return cached;

  const raw = await fetchJson<IocStationRaw[]>(`${BASE}?query=stationlist&format=json`);
  if (!raw) {
    ctx.log.warn("IOC station list unavailable");
    return [];
  }
  const seen = new Set<string>();
  const stations: CachedStation[] = [];
  for (const s of raw) {
    if (s.status !== 1) continue;
    if (!Number.isFinite(s.Lat) || !Number.isFinite(s.Lon)) continue;
    if (seen.has(s.Code)) continue;
    seen.add(s.Code);
    stations.push({
      code: s.Code,
      name: s.Location.trim() || s.Code,
      lat: s.Lat,
      lng: s.Lon,
      country: s.country,
    });
  }
  await ctx.cache.set("catalog", stations, CATALOG_TTL);
  return stations;
}

async function fetchObservations(stationCode: string): Promise<IocDataPoint[]> {
  // `period` is in days; 1 day = the last 24 h of observations.
  const url = `${BASE}?query=data&code=${encodeURIComponent(stationCode)}&format=json&period=1`;
  const raw = await fetchJson<IocDataPoint[]>(url);
  if (!raw) return [];
  // Some stations publish multiple sensor types; pick the most-populated one.
  const bySensor = new Map<string, IocDataPoint[]>();
  for (const p of raw) {
    if (!Number.isFinite(p.slevel)) continue;
    const list = bySensor.get(p.sensor) ?? [];
    list.push(p);
    bySensor.set(p.sensor, list);
  }
  let best: IocDataPoint[] = [];
  for (const list of bySensor.values()) {
    if (list.length > best.length) best = list;
  }
  return best.sort((a, b) => a.stime.localeCompare(b.stime));
}

/**
 * Derive past H/L events from the observation series (metres). Uses the shared
 * hysteresis detector so sensor noise / flat plateaus don't produce spurious
 * extrema. Threshold: 3 cm or 12 % of the observed range, whichever is larger.
 */
function deriveExtrema(curve: Array<{ time: string; value: number }>): TideEvent[] {
  return findTideExtrema(curve, { minDelta: 0.03, relativeDelta: 0.12 }).map((e) => ({
    time: e.time,
    type: e.type,
    valueFt: Math.round(e.value * M_TO_FT * 100) / 100,
  }));
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const hourKey = new Date().toISOString().slice(0, 13);
  const cacheKey = `tides:${station.code}:${hourKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) return cached;

  const obs = await fetchObservations(station.code);
  if (obs.length === 0) return null;

  // IOC raw gauge data carries occasional spikes / sentinels (e.g. an exact
  // -1.0 m glitch); drop them before plotting or deriving extrema, since one
  // outlier corrupts the range, threshold and event list. 0.25 m is far beyond
  // any real tide change over the ~15 s sampling interval.
  const curveRaw = despikeSeries(
    obs.map((p) => ({ time: reformatIocTime(p.stime), value: p.slevel })),
    0.25,
  );
  const curve = curveRaw.map((p) => ({
    time: p.time,
    valueFt: Math.round(p.value * M_TO_FT * 100) / 100,
  }));

  const events = deriveExtrema(curveRaw);

  const last = curveRaw[curveRaw.length - 1];

  const result: TidesResponse = {
    station: {
      id: station.code,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      distanceKm: Number(distanceKm.toFixed(2)),
    },
    events,
    curve,
    datum: "MLLW",
    units: "english",
    timeZone: "lst_ldt",
    currentLevel: {
      time: last.time,
      valueFt: Math.round(last.value * M_TO_FT * 100) / 100,
    },
  };
  await ctx.cache.set(cacheKey, result, TIDES_TTL);
  return result;
}

export function setup(ctx: IntegrationContext): void {
  createTidesIntegration<CachedStation, TidesResponse>(ctx, {
    scheme: "ioc",
    loadStations,
    findStationById: (stations, id) => stations.find((s) => s.code === id),
    createPlace: (station): Place =>
      createPlace({
        primaryScheme: "ioc",
        ids: { ioc: station.code },
        name: station.name,
        address: "",
        coordinates: [station.lng, station.lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      }),
    buildTidesResponse,
    maxStationDistanceKm: MAX_STATION_DISTANCE_KM,
    nearestCacheTtl: TIDES_TTL,
    cacheControlMaxAge: 1800,
    unavailableMessage: "Observations unavailable",
  });
}
