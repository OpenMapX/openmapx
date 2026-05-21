import { createPlace, type Place, USER_AGENT } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";

/**
 * Canadian tide-prediction + observation knowledge integration. Wraps the
 * DFO IWLS REST API (https://api-iwls.dfo-mpo.gc.ca/) to expose tide events,
 * a 30-min curve, and the latest observed water level for any Canadian
 * place near a CHS station.
 *
 * Output shape matches `knowledge-noaa-tides`'s `TidesResponse` so the
 * existing `PlaceTidesContent` widget renders unchanged. Values are
 * converted from meters (the IWLS unit) to feet for parity with NOAA.
 *
 * Free + commercial use under Open Government Licence — Canada 2.0.
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

interface CachedStation {
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

interface TideEvent {
  /** ISO-8601 UTC, e.g. "2026-05-18T03:20:00Z". The shared place-panel
   *  parser detects the `Z` and converts to the user's browser-local zone. */
  time: string;
  type: "H" | "L";
  valueFt: number;
}

interface TidesResponse {
  station: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    distanceKm: number;
    timezoneCorrHours?: number;
  };
  events: TideEvent[];
  curve: Array<{ time: string; valueFt: number }>;
  datum: "MLLW";
  units: "english";
  timeZone: "lst_ldt";
  currentLevel?: { time: string; valueFt: number; quality?: string };
  met?: never;
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

function normalizeIwlsTimestamp(iso: string): string {
  // IWLS returns ISO-8601 UTC like "2026-05-18T03:20:00Z". Keep the `T` and
  // trailing `Z` so the place panel's parser can detect the UTC marker and
  // display the event in the user's browser-local time. Stripping the `Z`
  // made the widget treat the UTC numbers as wall-clock in the browser zone,
  // shifting events by the user's offset and sometimes onto the wrong day.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)Z?/);
  if (!m) return iso;
  return `${m[1]}Z`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
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
    if (d <= maxKm && (!best || d < best.distanceKm)) {
      best = { station: s, distanceKm: d };
    }
  }
  return best;
}

async function fetchHiloEvents(stationId: string): Promise<TideEvent[]> {
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

async function fetchCurve(stationId: string): Promise<Array<{ time: string; valueFt: number }>> {
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

async function fetchLatestObservation(
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
async function refreshCurrentLevel(
  ctx: IntegrationContext,
  stationId: string,
  hasWlo: boolean,
): Promise<{ time: string; valueFt: number } | undefined> {
  if (!hasWlo) return undefined;
  const obsKey = `obs:${stationId}`;
  const cached = await ctx.cache.get<{ time: string; valueFt: number } | { notFound: true }>(
    obsKey,
  );
  if (cached) return "notFound" in cached ? undefined : cached;
  const fetched = await fetchLatestObservation(stationId);
  await ctx.cache.set(obsKey, fetched ?? ({ notFound: true } as const), OBSERVATION_TTL);
  return fetched ?? undefined;
}

async function buildTidesResponse(
  ctx: IntegrationContext,
  station: CachedStation,
  distanceKm: number,
): Promise<TidesResponse | null> {
  const dayKey = new Date().toISOString().slice(0, 10);
  // High/low events + curve are deterministic; cache 6h.
  const cacheKey = `tides:${station.id}:${dayKey}`;
  const cached = await ctx.cache.get<TidesResponse>(cacheKey);
  if (cached) {
    cached.currentLevel = await refreshCurrentLevel(ctx, station.id, station.hasWlo);
    return cached;
  }

  const [events, curve] = await Promise.all([fetchHiloEvents(station.id), fetchCurve(station.id)]);
  if (events.length === 0 && curve.length === 0) return null;

  const currentLevel = await refreshCurrentLevel(ctx, station.id, station.hasWlo);

  const result: TidesResponse = {
    station: {
      id: station.id,
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
    currentLevel,
  };
  await ctx.cache.set(cacheKey, result, TIDES_TTL);
  return result;
}

export function setup(ctx: IntegrationContext): void {
  registerPlaceResolver("ca-iwls", async (value, resolveCtx) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await loadStations(ctx);
    const station = stations.find((s) => s.id === id || s.code === id);
    if (!station) return null;
    const place: Place = createPlace({
      primaryScheme: "ca-iwls",
      ids: { "ca-iwls": station.id },
      name: station.name,
      address: "",
      countryCode: "ca",
      coordinates: [station.lng, station.lat],
      category: "Tide Station",
      rawCategory: "marine/tide_station",
    });
    void resolveCtx;
    return place;
  });

  ctx.registerRoute("GET", "/tides", async (req, reply) => {
    const stationParam = req.query.station;
    let resolvedStation: CachedStation | null = null;
    let distanceKm = 0;

    if (stationParam) {
      const stations = await loadStations(ctx);
      const found = stations.find((s) => s.id === stationParam || s.code === stationParam);
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

      // Cache key MUST include the UTC date — events carry calendar dates and
      // a 6-hour TTL straddling midnight UTC would otherwise serve yesterday's
      // events under today's labels. Matches the NOAA integration's pattern.
      const dayKey = new Date().toISOString().slice(0, 10);
      const cacheKey = `nearest:${round4(lat)},${round4(lng)}:${dayKey}`;
      const cached = await ctx.cache.get<TidesResponse | { notFound: true }>(cacheKey);
      if (cached) {
        if ("notFound" in cached) {
          reply.status(204).send(null);
          return;
        }
        // The `nearest:` fast path bypasses `buildTidesResponse`, so its
        // canonical 5-min `obs:` refresh is skipped. Re-fetch the current
        // water level here so warm hits don't pin a stale `currentLevel`
        // for the full 6-hour TIDES_TTL. We treat the previously-cached
        // `currentLevel` as proof the station supports WLO; stations that
        // had no obs at build time stay live-free.
        if (cached.currentLevel !== undefined) {
          cached.currentLevel = await refreshCurrentLevel(ctx, cached.station.id, true);
        }
        reply.header("Cache-Control", "public, max-age=3600");
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
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(result);
      return;
    }

    const result = await buildTidesResponse(ctx, resolvedStation, distanceKm);
    if (!result) {
      reply.status(502).send({ message: "Tide predictions unavailable" });
      return;
    }
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(result);
  });
}
