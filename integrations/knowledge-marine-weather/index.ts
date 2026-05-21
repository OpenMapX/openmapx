import { USER_AGENT } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";

const BASE = "https://marine-api.open-meteo.com/v1/marine";
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL = 30 * 60; // 30 min — wave models refresh every 6–12h, but tighter is fine
const NOT_FOUND_TTL = 60 * 60; // 1h — cache "no marine data here" too

const HOURLY_FIELDS = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "wind_wave_height",
  "wind_wave_direction",
  "wind_wave_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "ocean_current_velocity",
  "ocean_current_direction",
  // Modeled sea-level relative to MSL — gives a global tide curve for
  // coordinates that aren't covered by any national prediction network.
  "sea_level_height_msl",
].join(",");

interface OpenMeteoMarineResponse {
  latitude?: number;
  longitude?: number;
  hourly?: {
    time: string[];
    wave_height?: Array<number | null>;
    wave_direction?: Array<number | null>;
    wave_period?: Array<number | null>;
    wind_wave_height?: Array<number | null>;
    wind_wave_direction?: Array<number | null>;
    wind_wave_period?: Array<number | null>;
    swell_wave_height?: Array<number | null>;
    swell_wave_direction?: Array<number | null>;
    swell_wave_period?: Array<number | null>;
    ocean_current_velocity?: Array<number | null>;
    ocean_current_direction?: Array<number | null>;
    sea_level_height_msl?: Array<number | null>;
  };
  /** Open-Meteo returns this for inland points where no marine data exists. */
  error?: boolean;
  reason?: string;
}

interface MarineHourlyPoint {
  time: string;
  waveHeightM?: number;
  waveDirectionDeg?: number;
  wavePeriodS?: number;
  windWaveHeightM?: number;
  windWaveDirectionDeg?: number;
  windWavePeriodS?: number;
  swellHeightM?: number;
  swellDirectionDeg?: number;
  swellPeriodS?: number;
  currentVelocityMs?: number;
  currentDirectionDeg?: number;
  /** Modeled sea level relative to MSL, in meters. Globally available. */
  seaLevelHeightM?: number;
}

/** Douglas Sea Scale, from significant wave height in meters. */
type DouglasState =
  | "calm-glassy"
  | "calm-rippled"
  | "smooth"
  | "slight"
  | "moderate"
  | "rough"
  | "very-rough"
  | "high"
  | "very-high"
  | "phenomenal";

interface MarineCurrent {
  time: string;
  waveHeightM?: number;
  waveDirectionDeg?: number;
  wavePeriodS?: number;
  swellHeightM?: number;
  swellDirectionDeg?: number;
  swellPeriodS?: number;
  currentVelocityMs?: number;
  currentDirectionDeg?: number;
  seaState: DouglasState;
}

interface MarineResponse {
  location: { lat: number; lng: number };
  current: MarineCurrent;
  hourly: MarineHourlyPoint[];
  source: "open-meteo-marine";
}

function douglasFromWaveHeight(waveHeightM: number | undefined): DouglasState {
  if (waveHeightM === undefined) return "calm-glassy";
  if (waveHeightM <= 0) return "calm-glassy";
  if (waveHeightM <= 0.1) return "calm-rippled";
  if (waveHeightM <= 0.5) return "smooth";
  if (waveHeightM <= 1.25) return "slight";
  if (waveHeightM <= 2.5) return "moderate";
  if (waveHeightM <= 4) return "rough";
  if (waveHeightM <= 6) return "very-rough";
  if (waveHeightM <= 9) return "high";
  if (waveHeightM <= 14) return "very-high";
  return "phenomenal";
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function pickNumber(arr: Array<number | null> | undefined, idx: number): number | undefined {
  if (!arr) return undefined;
  const v = arr[idx];
  return v === null || v === undefined ? undefined : v;
}

function parseHourly(data: OpenMeteoMarineResponse): MarineHourlyPoint[] {
  const h = data.hourly;
  if (!h?.time) return [];
  return h.time.map((time, i) => ({
    time,
    waveHeightM: pickNumber(h.wave_height, i),
    waveDirectionDeg: pickNumber(h.wave_direction, i),
    wavePeriodS: pickNumber(h.wave_period, i),
    windWaveHeightM: pickNumber(h.wind_wave_height, i),
    windWaveDirectionDeg: pickNumber(h.wind_wave_direction, i),
    windWavePeriodS: pickNumber(h.wind_wave_period, i),
    swellHeightM: pickNumber(h.swell_wave_height, i),
    swellDirectionDeg: pickNumber(h.swell_wave_direction, i),
    swellPeriodS: pickNumber(h.swell_wave_period, i),
    currentVelocityMs: pickNumber(h.ocean_current_velocity, i),
    currentDirectionDeg: pickNumber(h.ocean_current_direction, i),
    seaLevelHeightM: pickNumber(h.sea_level_height_msl, i),
  }));
}

function buildCurrent(hourly: MarineHourlyPoint[]): MarineCurrent | null {
  if (hourly.length === 0) return null;
  // Find the hour closest to "now" — Open-Meteo returns hourly aligned to UTC.
  const now = Date.now();
  let bestIdx = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hourly.length; i++) {
    const diff = Math.abs(new Date(hourly[i].time).getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  const h = hourly[bestIdx];
  return {
    time: h.time,
    waveHeightM: h.waveHeightM,
    waveDirectionDeg: h.waveDirectionDeg,
    wavePeriodS: h.wavePeriodS,
    swellHeightM: h.swellHeightM,
    swellDirectionDeg: h.swellDirectionDeg,
    swellPeriodS: h.swellPeriodS,
    currentVelocityMs: h.currentVelocityMs,
    currentDirectionDeg: h.currentDirectionDeg,
    seaState: douglasFromWaveHeight(h.waveHeightM),
  };
}

async function fetchMarine(lat: number, lng: number): Promise<OpenMeteoMarineResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url =
      `${BASE}?latitude=${round2(lat)}&longitude=${round2(lng)}` +
      `&hourly=${HOURLY_FIELDS}&forecast_days=3&timezone=auto`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as OpenMeteoMarineResponse;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/marine", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat ?? "");
    const lng = Number.parseFloat(req.query.lng ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      reply.status(400).send({ message: "Out-of-range coordinates" });
      return;
    }

    const cacheKey = `marine:${round2(lat)},${round2(lng)}`;
    const cached = await ctx.cache.get<MarineResponse | { notFound: true }>(cacheKey);
    if (cached) {
      if ("notFound" in cached) {
        reply.status(204).send(null);
        return;
      }
      reply.header("Cache-Control", "public, max-age=1800");
      reply.send(cached);
      return;
    }

    const data = await fetchMarine(lat, lng);
    if (!data || data.error || !data.hourly) {
      // Open-Meteo returns `error: true` for inland points outside any
      // marine model grid. Cache that result so we don't pound the upstream
      // every time the user opens an inland POI.
      await ctx.cache.set(cacheKey, { notFound: true }, NOT_FOUND_TTL);
      reply.status(204).send(null);
      return;
    }

    const hourly = parseHourly(data);
    const current = buildCurrent(hourly);
    if (!current) {
      await ctx.cache.set(cacheKey, { notFound: true }, NOT_FOUND_TTL);
      reply.status(204).send(null);
      return;
    }

    const result: MarineResponse = {
      location: { lat, lng },
      current,
      hourly: hourly.slice(0, 48),
      source: "open-meteo-marine",
    };
    await ctx.cache.set(cacheKey, result, CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=1800");
    reply.send(result);
  });
}
