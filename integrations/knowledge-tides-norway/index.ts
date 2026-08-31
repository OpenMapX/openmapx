import { createPlace, type Place, USER_AGENT } from "@openmapx/core";
import {
  createTidesIntegration,
  type IntegrationContext,
  type TideCurvePoint,
  type TideEvent,
  type TidesResponse,
} from "@openmapx/integration-framework";

/**
 * Norwegian tide-prediction knowledge integration. Wraps Kartverket
 * Sehavnivå (https://vannstand.kartverket.no/tideapi.php), which publishes
 * tide predictions (PRE) and observations (OBS) for ~30 permanent stations
 * along Norway + Svalbard.
 *
 * Values are converted from centimeters (Sehavnivå's unit, referenced to
 * chart datum CD) to feet for the shared tide response.
 *
 * Free + commercial use under NLOD 2.0.
 *
 * The place-resolver + `/tides` route shell (nearest-station lookup, per-day
 * `nearest:` cache, `{ notFound: true }` sentinel, `Cache-Control`) lives in
 * the shared `createTidesIntegration` factory; everything below is the
 * Kartverket-specific catalog/prediction handling.
 */
const BASE = "https://vannstand.kartverket.no/tideapi.php";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 6 * 60 * 60;
const MAX_STATION_DISTANCE_KM = 50; // Norway has only ~30 stations; widen the radius
const CM_TO_FT = 0.0328084;

export interface CachedStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

export function isoTimeFromKartverket(stamp: string): string {
  // Kartverket returns "2026-05-18T05:24:00+01:00" — keep the offset so the
  // place-panel parser picks the ISO branch in `parseLocalTime` and renders
  // the event in the user's browser-local zone. Dropping the offset made the
  // widget treat Norway-local numbers as the viewer's wall-clock, shifting
  // events by the user's UTC offset for anyone outside Norway.
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))/);
  if (!m) return stamp;
  return m[1];
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,*/*" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function loadStations(ctx: IntegrationContext): Promise<CachedStation[]> {
  const cached = await ctx.cache.get<CachedStation[]>("catalog");
  if (cached) return cached;

  const xml = await fetchText(`${BASE}?tide_request=stationlist&type=perm&lang=en`);
  if (!xml) {
    ctx.log.warn("Kartverket station list unavailable");
    return [];
  }
  const stations: CachedStation[] = [];
  const re =
    /<location\s+name="([^"]+)"\s+code="([^"]+)"\s+latitude="([\d.-]+)"\s+longitude="([\d.-]+)"\s+type="PERM"\s*\/>/g;
  for (const m of xml.matchAll(re)) {
    const lat = Number.parseFloat(m[3]);
    const lng = Number.parseFloat(m[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stations.push({ code: m[2], name: m[1], lat, lng });
  }
  await ctx.cache.set("catalog", stations, CATALOG_TTL);
  return stations;
}

function buildDateWindow(): { from: string; to: string } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  return {
    from: start.toISOString().slice(0, 16),
    to: end.toISOString().slice(0, 16),
  };
}

export async function fetchHilo(station: CachedStation): Promise<TideEvent[]> {
  const { from, to } = buildDateWindow();
  const url =
    `${BASE}?lat=${station.lat}&lon=${station.lng}` +
    `&fromtime=${encodeURIComponent(from)}&totime=${encodeURIComponent(to)}` +
    `&datatype=TAB&refcode=CD&place=${encodeURIComponent(station.name)}` +
    `&lang=en&dst=0&tide_request=locationdata`;
  const xml = await fetchText(url);
  if (!xml) return [];
  const events: TideEvent[] = [];
  // <waterlevel value="14.3" time="2026-05-18T05:24:00+01:00" flag="low"/>
  const re = /<waterlevel\s+value="([\d.-]+)"\s+time="([^"]+)"\s+flag="(high|low)"\s*\/>/g;
  for (const m of xml.matchAll(re)) {
    const cm = Number.parseFloat(m[1]);
    if (!Number.isFinite(cm)) continue;
    events.push({
      time: isoTimeFromKartverket(m[2]),
      type: m[3] === "high" ? "H" : "L",
      valueFt: Math.round(cm * CM_TO_FT * 100) / 100,
    });
  }
  return events;
}

export async function fetchCurve(station: CachedStation): Promise<TideCurvePoint[]> {
  const { from, to } = buildDateWindow();
  const url =
    `${BASE}?lat=${station.lat}&lon=${station.lng}` +
    `&fromtime=${encodeURIComponent(from)}&totime=${encodeURIComponent(to)}` +
    `&datatype=PRE&refcode=CD&place=${encodeURIComponent(station.name)}` +
    `&lang=en&interval=30&dst=0&tide_request=locationdata`;
  const xml = await fetchText(url);
  if (!xml) return [];
  const curve: TideCurvePoint[] = [];
  const re = /<waterlevel\s+value="([\d.-]+)"\s+time="([^"]+)"\s+flag="pre"\s*\/>/g;
  for (const m of xml.matchAll(re)) {
    const cm = Number.parseFloat(m[1]);
    if (!Number.isFinite(cm)) continue;
    curve.push({
      time: isoTimeFromKartverket(m[2]),
      valueFt: Math.round(cm * CM_TO_FT * 100) / 100,
    });
  }
  return curve;
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const dayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = `tides:${station.code}:${dayKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) return cached;

  const [events, curve] = await Promise.all([fetchHilo(station), fetchCurve(station)]);
  if (events.length === 0 && curve.length === 0) return null;

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
  };
  await ctx.cache.set(cacheKey, result, TIDES_TTL);
  return result;
}

export function setup(ctx: IntegrationContext): void {
  createTidesIntegration<CachedStation>(ctx, {
    scheme: "kartverket",
    loadStations,
    findStationById: (stations, id) => stations.find((s) => s.code === id),
    createPlace: (station): Place =>
      createPlace({
        primaryScheme: "kartverket",
        ids: { kartverket: station.code },
        name: station.name,
        address: "",
        countryCode: "no",
        coordinates: [station.lng, station.lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      }),
    buildTidesResponse,
    maxStationDistanceKm: MAX_STATION_DISTANCE_KM,
    nearestCacheTtl: TIDES_TTL,
    cacheControlMaxAge: 3600,
    unavailableMessage: "Tide predictions unavailable",
  });
}
