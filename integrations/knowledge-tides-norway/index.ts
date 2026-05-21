import { createPlace, type Place, USER_AGENT } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";

/**
 * Norwegian tide-prediction knowledge integration. Wraps Kartverket
 * Sehavnivå (https://vannstand.kartverket.no/tideapi.php), which publishes
 * tide predictions (PRE) and observations (OBS) for ~30 permanent stations
 * along Norway + Svalbard.
 *
 * Output matches `knowledge-noaa-tides`'s `TidesResponse`. Values are
 * converted from centimeters (Sehavnivå's unit, referenced to chart datum
 * CD) to feet for parity with the existing widget.
 *
 * Free + commercial use under NLOD 2.0.
 */
const BASE = "https://vannstand.kartverket.no/tideapi.php";
const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL = 7 * 24 * 60 * 60;
const TIDES_TTL = 6 * 60 * 60;
const MAX_STATION_DISTANCE_KM = 50; // Norway has only ~30 stations; widen the radius
const CM_TO_FT = 0.0328084;

interface CachedStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

interface TideEvent {
  time: string; // "YYYY-MM-DD HH:mm" UTC
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

function isoTimeFromKartverket(stamp: string): string {
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

function buildDateWindow(): { from: string; to: string } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  return {
    from: start.toISOString().slice(0, 16),
    to: end.toISOString().slice(0, 16),
  };
}

async function fetchHilo(station: CachedStation): Promise<TideEvent[]> {
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

async function fetchCurve(
  station: CachedStation,
): Promise<Array<{ time: string; valueFt: number }>> {
  const { from, to } = buildDateWindow();
  const url =
    `${BASE}?lat=${station.lat}&lon=${station.lng}` +
    `&fromtime=${encodeURIComponent(from)}&totime=${encodeURIComponent(to)}` +
    `&datatype=PRE&refcode=CD&place=${encodeURIComponent(station.name)}` +
    `&lang=en&interval=30&dst=0&tide_request=locationdata`;
  const xml = await fetchText(url);
  if (!xml) return [];
  const curve: Array<{ time: string; valueFt: number }> = [];
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
  registerPlaceResolver("kartverket", async (value) => {
    const id = value.split(":")[0].trim();
    if (!id) return null;
    const stations = await loadStations(ctx);
    const station = stations.find((s) => s.code === id);
    if (!station) return null;
    const place: Place = createPlace({
      primaryScheme: "kartverket",
      ids: { kartverket: station.code },
      name: station.name,
      address: "",
      countryCode: "no",
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

      // Include the UTC date — events carry calendar dates and a 6-hour TTL
      // straddling midnight UTC would otherwise serve yesterday's events under
      // today's labels. Matches the station-keyed cache and the NOAA pattern.
      const dayKey = new Date().toISOString().slice(0, 10);
      const cacheKey = `nearest:${round4(lat)},${round4(lng)}:${dayKey}`;
      const cached = await ctx.cache.get<TidesResponse | { notFound: true }>(cacheKey);
      if (cached) {
        if ("notFound" in cached) {
          reply.status(204).send(null);
          return;
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
