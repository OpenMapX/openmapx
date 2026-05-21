import type { Logger } from "@openmapx/integration-framework";
import type { MetReadings, TideEvent, WaterLevelReading } from "./types.js";

const DATA_API_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const FETCH_TIMEOUT_MS = 15_000;

interface DatagetterPredictionsResponse {
  predictions?: Array<{ t: string; v: string; type?: string }>;
  error?: { message?: string };
}

interface DatagetterWaterLevelResponse {
  data?: Array<{ t: string; v: string; s?: string; f?: string; q?: string }>;
  error?: { message?: string };
}

interface DatagetterMetResponse {
  data?: Array<{ t: string; v: string; s?: string; d?: string; g?: string; f?: string }>;
  error?: { message?: string };
}

function utcDateMinusOneDay(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch high/low tide events for a station from NOAA CO-OPS Data API.
 *
 * NOAA interprets `begin_date` in the requested `time_zone` (the station's
 * local time when `lst_ldt` is set), but the API server computing the date
 * runs in UTC. For a user in EDT/PDT querying late in their evening, UTC has
 * already rolled to "tomorrow" — querying with `begin_date=todayUTC` then
 * drops their still-future tonight events. To stay correct for any user TZ
 * we step back one UTC day and request a 72-hour window; the client filters
 * past events out.
 */
export async function fetchHighLowPredictions(
  stationId: string,
  log: Logger,
): Promise<TideEvent[] | null> {
  const params = new URLSearchParams({
    station: stationId,
    product: "predictions",
    interval: "hilo",
    begin_date: utcDateMinusOneDay(),
    range: "72",
    datum: "MLLW",
    units: "english",
    time_zone: "lst_ldt",
    format: "json",
    application: "OpenMapX",
  });

  const res = await fetchWithTimeout(`${DATA_API_URL}?${params.toString()}`);
  if (!res) {
    log.warn(`noaa-coops: predictions fetch failed for ${stationId}`);
    return null;
  }
  if (!res.ok) {
    log.warn(`noaa-coops: predictions HTTP ${res.status} for ${stationId}`);
    return null;
  }
  const body = (await res.json()) as DatagetterPredictionsResponse;
  if (body.error?.message) {
    log.warn(`noaa-coops: predictions error for ${stationId}: ${body.error.message}`);
    return null;
  }
  return (body.predictions ?? [])
    .map((p) => ({
      time: p.t,
      type: (p.type === "H" || p.type === "L" ? p.type : "H") as "H" | "L",
      valueFt: Number.parseFloat(p.v),
    }))
    .filter((e) => Number.isFinite(e.valueFt));
}

/**
 * Fetch a continuous tide-prediction curve for charting. 6-min interval over
 * 24 h starting yesterday-UTC (same TZ rationale as the hi/lo fetcher).
 */
export async function fetchTideCurve(
  stationId: string,
  log: Logger,
  hours = 48,
): Promise<TideEvent[] | null> {
  const params = new URLSearchParams({
    station: stationId,
    product: "predictions",
    interval: "30",
    begin_date: utcDateMinusOneDay(),
    range: String(hours),
    datum: "MLLW",
    units: "english",
    time_zone: "lst_ldt",
    format: "json",
    application: "OpenMapX",
  });

  const res = await fetchWithTimeout(`${DATA_API_URL}?${params.toString()}`);
  if (!res?.ok) {
    log.warn(`noaa-coops: curve fetch failed for ${stationId}`);
    return null;
  }
  const body = (await res.json()) as DatagetterPredictionsResponse;
  if (body.error?.message) return null;
  return (body.predictions ?? [])
    .map((p) => ({
      time: p.t,
      type: "H" as const,
      valueFt: Number.parseFloat(p.v),
    }))
    .filter((e) => Number.isFinite(e.valueFt));
}

/**
 * Latest 6-min observed water-level sample. NOAA returns `q=p` (preliminary)
 * for real-time data; verified values come in days later and carry `q=v`.
 * Surface the preliminary flag so the UI can warn users.
 */
export async function fetchLatestWaterLevel(
  stationId: string,
  log: Logger,
): Promise<WaterLevelReading | null> {
  const params = new URLSearchParams({
    station: stationId,
    product: "water_level",
    date: "latest",
    datum: "MLLW",
    units: "english",
    time_zone: "lst_ldt",
    format: "json",
    application: "OpenMapX",
  });

  const res = await fetchWithTimeout(`${DATA_API_URL}?${params.toString()}`);
  if (!res?.ok) return null;
  const body = (await res.json()) as DatagetterWaterLevelResponse;
  if (body.error?.message) {
    log.debug?.(`noaa-coops: no water_level for ${stationId}: ${body.error.message}`);
    return null;
  }
  const latest = body.data?.[body.data.length - 1];
  if (!latest) return null;
  const v = Number.parseFloat(latest.v);
  if (!Number.isFinite(v)) return null;
  return {
    time: latest.t,
    valueFt: v,
    quality: latest.q,
  };
}

/**
 * Met readings published by a subset of CO-OPS stations. NOAA exposes each
 * meteorological channel as a separate `product=`, so we fetch the latest
 * sample for each and merge into a single shape. Stations that don't
 * publish a given product return an error inside the JSON; we silently
 * drop those.
 */
export async function fetchLatestMet(stationId: string, log: Logger): Promise<MetReadings | null> {
  const products = ["wind", "air_pressure", "water_temperature", "air_temperature"] as const;

  const results = await Promise.all(
    products.map(async (product) => {
      const params = new URLSearchParams({
        station: stationId,
        product,
        date: "latest",
        units: "english",
        time_zone: "lst_ldt",
        format: "json",
        application: "OpenMapX",
      });
      const res = await fetchWithTimeout(`${DATA_API_URL}?${params.toString()}`);
      if (!res?.ok) return null;
      const body = (await res.json()) as DatagetterMetResponse;
      if (body.error?.message) return null;
      const latest = body.data?.[body.data.length - 1];
      if (!latest) return null;
      return { product, latest };
    }),
  );

  let result: MetReadings | null = null;
  for (const row of results) {
    if (!row) continue;
    result ??= {};
    if (row.latest.t) result.time = row.latest.t;
    const v = Number.parseFloat(row.latest.v);
    if (!Number.isFinite(v)) continue;
    switch (row.product) {
      case "wind":
        result.windKnots = v;
        if (row.latest.d) {
          const dir = Number.parseFloat(row.latest.d);
          if (Number.isFinite(dir)) result.windDirDeg = dir;
        }
        if (row.latest.g) {
          const gust = Number.parseFloat(row.latest.g);
          if (Number.isFinite(gust)) result.windGustKnots = gust;
        }
        break;
      case "air_pressure":
        result.pressureMb = v;
        break;
      case "water_temperature":
        result.waterTempF = v;
        break;
      case "air_temperature":
        result.airTempF = v;
        break;
    }
  }
  // Squelch unused-arg warning for the optional debug logger above.
  void log;
  return result;
}
