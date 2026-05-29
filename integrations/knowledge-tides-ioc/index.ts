import {
  createPlace,
  despikeSeries,
  findTideExtrema,
  type Place,
  USER_AGENT,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";

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

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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

function findNearest(
  stations: CachedStation[],
  lat: number,
  lng: number,
  maxKm = MAX_STATION_DISTANCE_KM,
): { station: CachedStation; distanceKm: number } | null {
  let best: { station: CachedStation; distanceKm: number } | null = null;
  for (const s of stations) {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { station: s, distanceKm: d };
  }
  return best;
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
  registerPlaceResolver("ioc", async (value) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await loadStations(ctx);
    const station = stations.find((s) => s.code === id);
    if (!station) return null;
    const place: Place = createPlace({
      primaryScheme: "ioc",
      ids: { ioc: station.code },
      name: station.name,
      address: "",
      coordinates: [station.lng, station.lat],
      category: "Tide Station",
      rawCategory: "marine/tide_station",
    });
    return place;
  });

  ctx.registerRoute("GET", "/tides", async (req, reply) => {
    const stationParam = req.query.station;
    let resolvedStation: CachedStation | null = null;
    let distanceKm = 0;

    if (stationParam) {
      const stations = await loadStations(ctx);
      const found = stations.find((s) => s.code === stationParam);
      if (!found) {
        reply.status(404).send({ message: "Unknown station" });
        return;
      }
      resolvedStation = found;
    } else {
      const lat = Number.parseFloat(req.query.lat ?? "");
      const lng = Number.parseFloat(req.query.lng ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        reply.status(400).send({ message: "Invalid coordinates" });
        return;
      }

      // Include the UTC date — events are bucketed today/tomorrow on the
      // client, so a cached response that spans midnight UTC would land
      // yesterday's events under today's label until the TTL expires.
      const dayKey = new Date().toISOString().slice(0, 10);
      const cacheKey = `nearest:${round4(lat)},${round4(lng)}:${dayKey}`;
      const cached = await ctx.cache.get<TidesResponse | { notFound: true }>(cacheKey);
      if (cached) {
        if ("notFound" in cached) {
          reply.status(204).send(null);
          return;
        }
        reply.header("Cache-Control", "public, max-age=1800");
        reply.send(cached);
        return;
      }

      const stations = await loadStations(ctx);
      const nearest = findNearest(stations, lat, lng);
      if (!nearest) {
        await ctx.cache.set(cacheKey, { notFound: true } as const, TIDES_TTL);
        reply.status(204).send(null);
        return;
      }
      resolvedStation = nearest.station;
      distanceKm = nearest.distanceKm;

      const result = await buildTidesResponse(ctx, resolvedStation, distanceKm);
      if (!result) {
        await ctx.cache.set(cacheKey, { notFound: true } as const, TIDES_TTL);
        reply.status(204).send(null);
        return;
      }
      await ctx.cache.set(cacheKey, result, TIDES_TTL);
      reply.header("Cache-Control", "public, max-age=1800");
      reply.send(result);
      return;
    }

    const result = await buildTidesResponse(ctx, resolvedStation, distanceKm);
    if (!result) {
      reply.status(502).send({ message: "Observations unavailable" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=1800");
    reply.send(result);
  });
}
