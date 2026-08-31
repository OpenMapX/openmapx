import {
  fetchJson as coreFetchJson,
  createPlace,
  despikeSeries,
  findTideExtrema,
  type Place,
} from "@openmapx/core";
import {
  createTidesIntegration,
  type IntegrationContext,
  type TideEvent,
  type TidesResponse,
} from "@openmapx/integration-framework";

/**
 * German coastal water-level observations from WSV Pegelonline. Wraps:
 *
 *   /webservices/rest-api/v2/stations.json?waters=NORDSEE,OSTSEE  — catalog
 *   /webservices/rest-api/v2/stations/<uuid>/W/measurements.json  — curve
 *
 * Pegelonline publishes minute-resolution observations in cm above the
 * station's gauge zero (PNP). The integration converts to feet relative to
 * the same reference for parity with NOAA. Predictions are NOT published —
 * the integration derives high/low events from the past 24 h of observations.
 *
 * Free + commercial use under Datenlizenz Deutschland Zero 2.0 (no
 * restrictions).
 *
 * The place-resolver + `/tides` route shell (nearest-station lookup, per-day
 * `nearest:` cache, `{ notFound: true }` sentinel, `Cache-Control`) lives in
 * the shared `createTidesIntegration` factory; everything below is the
 * Pegelonline-specific catalog/measurement handling.
 */
const BASE = "https://www.pegelonline.wsv.de/webservices/rest-api/v2";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 15 * 60; // observations refresh frequently
const MAX_STATION_DISTANCE_KM = 25;
const CM_TO_FT = 0.0328084;

interface PegelStationRaw {
  uuid: string;
  shortname: string;
  longname: string;
  longitude: number;
  latitude: number;
  water?: { shortname: string };
}

interface PegelMeasurement {
  timestamp: string; // "2026-05-18T06:15:00+02:00"
  value: number; // cm
}

interface CachedStation {
  uuid: string;
  name: string;
  lat: number;
  lng: number;
}

export function reformatPegelTime(stamp: string): string {
  // Pegelonline returns "2026-05-18T06:15:00+02:00" (German local with
  // offset). Preserve the offset so the place-panel parser detects the ISO
  // form and renders in the viewer's browser-local zone. Stripping it left
  // wall-clock numbers that the widget read as the viewer's local time —
  // events would shift by the user's UTC offset outside Germany.
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))/);
  if (!m) return stamp;
  return m[1];
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

  const raw = await fetchJson<PegelStationRaw[]>(`${BASE}/stations.json?waters=NORDSEE,OSTSEE`);
  if (!raw) {
    ctx.log.warn("Pegelonline station list unavailable");
    return [];
  }
  const stations: CachedStation[] = raw
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => ({
      uuid: s.uuid,
      name: s.shortname.replace(/\s+/g, " ").trim(),
      lat: s.latitude,
      lng: s.longitude,
    }));
  await ctx.cache.set("catalog", stations, CATALOG_TTL);
  return stations;
}

export async function fetchMeasurements(uuid: string): Promise<PegelMeasurement[]> {
  // P1D = last 24 h. Resulting payload can be large (1-min resolution); we
  // resample to 15-min steps to match the existing NOAA curve density.
  const raw = await fetchJson<PegelMeasurement[]>(
    `${BASE}/stations/${uuid}/W/measurements.json?start=P1D`,
  );
  if (!raw) return [];
  // Downsample: keep every 15th sample (~15 min if equidistance=1).
  return raw.filter((_, i) => i % 15 === 0);
}

/**
 * Derive H/L events from the water-level series (cm). Uses the shared
 * hysteresis detector so sensor noise / flat plateaus don't produce spurious
 * extrema. Threshold: 5 cm or 12 % of the observed range, whichever is larger.
 */
export function deriveExtrema(curve: Array<{ time: string; valueCm: number }>): TideEvent[] {
  const samples = curve.map((p) => ({ time: p.time, value: p.valueCm }));
  return findTideExtrema(samples, { minDelta: 5, relativeDelta: 0.12 }).map((e) => ({
    time: e.time,
    type: e.type,
    valueFt: Math.round(e.value * CM_TO_FT * 100) / 100,
  }));
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const quarterKey = Math.floor(Date.now() / (TIDES_TTL * 1000));
  const cacheKey = `tides:${station.uuid}:${quarterKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) return cached;

  const obs = await fetchMeasurements(station.uuid);
  if (obs.length === 0) return null;

  // Drop spike/sentinel outliers (>25 cm from the local median) before plotting
  // or deriving extrema — one bad reading corrupts the range, threshold and events.
  const curveRaw = despikeSeries(
    obs.map((p) => ({ time: reformatPegelTime(p.timestamp), value: p.value })),
    25,
  ).map((p) => ({ time: p.time, valueCm: p.value }));
  const curve = curveRaw.map((p) => ({
    time: p.time,
    valueFt: Math.round(p.valueCm * CM_TO_FT * 100) / 100,
  }));
  const events = deriveExtrema(curveRaw);
  const last = curveRaw[curveRaw.length - 1];

  const result: TidesResponse = {
    station: {
      id: station.uuid,
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
      valueFt: Math.round(last.valueCm * CM_TO_FT * 100) / 100,
    },
  };
  await ctx.cache.set(cacheKey, result, TIDES_TTL);
  return result;
}

export function setup(ctx: IntegrationContext): void {
  createTidesIntegration<CachedStation>(ctx, {
    scheme: "pegel",
    loadStations,
    findStationById: (stations, id) => stations.find((s) => s.uuid === id),
    createPlace: (station): Place =>
      createPlace({
        primaryScheme: "pegel",
        ids: { pegel: station.uuid },
        name: station.name,
        address: "",
        countryCode: "de",
        coordinates: [station.lng, station.lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      }),
    buildTidesResponse,
    maxStationDistanceKm: MAX_STATION_DISTANCE_KM,
    nearestCacheTtl: TIDES_TTL,
    cacheControlMaxAge: 900,
    unavailableMessage: "Observations unavailable",
  });
}
