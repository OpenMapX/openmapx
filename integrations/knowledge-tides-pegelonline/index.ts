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

function reformatPegelTime(stamp: string): string {
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

async function fetchMeasurements(uuid: string): Promise<PegelMeasurement[]> {
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
function deriveExtrema(curve: Array<{ time: string; valueCm: number }>): TideEvent[] {
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
  registerPlaceResolver("pegel", async (value) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await loadStations(ctx);
    const station = stations.find((s) => s.uuid === id);
    if (!station) return null;
    const place: Place = createPlace({
      primaryScheme: "pegel",
      ids: { pegel: station.uuid },
      name: station.name,
      address: "",
      countryCode: "de",
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
      const found = stations.find((s) => s.uuid === stationParam);
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
        reply.header("Cache-Control", "public, max-age=900");
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
      reply.header("Cache-Control", "public, max-age=900");
      reply.send(result);
      return;
    }

    const result = await buildTidesResponse(ctx, resolvedStation, distanceKm);
    if (!result) {
      reply.status(502).send({ message: "Observations unavailable" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=900");
    reply.send(result);
  });
}
