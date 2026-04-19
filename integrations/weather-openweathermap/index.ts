import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  IntegrationContext,
  LngLat,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import { USER_AGENT } from "@openmapx/core";
import type { WeatherProvider } from "../weather/types.js";

const FETCH_TIMEOUT_MS = 10_000;
const BASE = "https://api.openweathermap.org/data/2.5";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Map OWM weather condition IDs to WMO codes (approximation). */
function owmIdToWmo(id: number): number {
  if (id >= 200 && id < 300) return id >= 230 ? 95 : 96;
  if (id >= 300 && id < 400) return id <= 311 ? 51 : 55;
  if (id >= 500 && id < 600) {
    if (id === 500) return 61;
    if (id === 501) return 63;
    if (id === 502 || id === 503) return 65;
    if (id === 511) return 66;
    if (id >= 520) return 80;
    return 61;
  }
  if (id >= 600 && id < 700) {
    if (id === 600) return 71;
    if (id === 601) return 73;
    if (id === 602) return 75;
    if (id >= 611) return 85;
    return 71;
  }
  if (id >= 700 && id < 800) return 45;
  if (id === 800) return 0;
  if (id === 801) return 1;
  if (id === 802) return 2;
  if (id === 803 || id === 804) return 3;
  return 0;
}

// 2.5 Current Weather response

interface OWM25Current {
  dt: number;
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  wind: { speed: number; deg: number; gust?: number };
  clouds: { all: number };
  weather: { id: number; icon: string }[];
  rain?: { "1h"?: number };
  snow?: { "1h"?: number };
  sys: { sunrise: number; sunset: number };
}

// 2.5 Forecast response

interface OWM25ForecastEntry {
  dt: number;
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  wind: { speed: number; deg: number; gust?: number };
  clouds: { all: number };
  weather: { id: number }[];
  pop: number;
  rain?: { "3h"?: number };
  snow?: { "3h"?: number };
  dt_txt: string;
}

interface OWM25ForecastResponse {
  list: OWM25ForecastEntry[];
}

function toIso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function toDateStr(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`OWM HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export function setup(ctx: IntegrationContext): void {
  const apiKey = ctx.config.apiKey as string | undefined;
  if (!apiKey) return;

  const provider: WeatherProvider = {
    id: "openweathermap",
    priority: 5,

    async getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse> {
      const units = options?.units === "imperial" ? "imperial" : "metric";
      const lang = options?.lang ?? "en";
      const url =
        `${BASE}/weather?lat=${round4(coords[1])}&lon=${round4(coords[0])}` +
        `&appid=${apiKey}&units=${units}&lang=${lang}`;

      const data = await fetchJson<OWM25Current>(url);
      const precip = (data.rain?.["1h"] ?? 0) + (data.snow?.["1h"] ?? 0);
      const wmoCode = owmIdToWmo(data.weather[0]?.id ?? 800);

      const isDay =
        data.sys.sunrise > 0 && data.sys.sunset > 0
          ? data.dt >= data.sys.sunrise && data.dt < data.sys.sunset
          : !data.weather[0]?.icon?.endsWith("n");

      // 2.5 returns m/s for metric, mph for imperial
      const windMultiplier = units === "metric" ? 3.6 : 1;

      return {
        location: coords,
        current: {
          temperature: data.main.temp,
          feelsLike: data.main.feels_like,
          humidity: data.main.humidity,
          pressure: data.main.pressure,
          windSpeed: data.wind.speed * windMultiplier,
          windDirection: data.wind.deg,
          windGusts: data.wind.gust ? data.wind.gust * windMultiplier : undefined,
          precipitation: precip,
          cloudCover: data.clouds.all,
          weatherCode: wmoCode,
          isDay,
          time: toIso(data.dt),
        },
        source: "openweathermap",
      };
    },

    async getHourlyForecast(
      coords: LngLat,
      hours: number,
      options?: WeatherOptions,
    ): Promise<HourlyForecastPoint[]> {
      const units = options?.units === "imperial" ? "imperial" : "metric";
      // 2.5 forecast returns 3-hour steps, max 40 entries (5 days)
      const cnt = Math.min(Math.ceil(hours / 3), 40);
      const url =
        `${BASE}/forecast?lat=${round4(coords[1])}&lon=${round4(coords[0])}` +
        `&appid=${apiKey}&units=${units}&cnt=${cnt}`;

      const data = await fetchJson<OWM25ForecastResponse>(url);
      const windMul = units === "metric" ? 3.6 : 1;

      return data.list.map((e) => ({
        time: toIso(e.dt),
        temperature: e.main.temp,
        weatherCode: owmIdToWmo(e.weather[0]?.id ?? 800),
        precipitationProbability: Math.round(e.pop * 100),
        precipitation: (e.rain?.["3h"] ?? 0) + (e.snow?.["3h"] ?? 0),
        windSpeed: e.wind.speed * windMul,
        windDirection: e.wind.deg,
        cloudCover: e.clouds.all,
        pressure: e.main.pressure,
      }));
    },

    async getDailyForecast(
      coords: LngLat,
      days: number,
      options?: WeatherOptions,
    ): Promise<DailyForecastPoint[]> {
      const units = options?.units === "imperial" ? "imperial" : "metric";
      // Fetch full 5-day forecast and aggregate into daily summaries
      const url =
        `${BASE}/forecast?lat=${round4(coords[1])}&lon=${round4(coords[0])}` +
        `&appid=${apiKey}&units=${units}&cnt=40`;

      const data = await fetchJson<OWM25ForecastResponse>(url);
      const windMul = units === "metric" ? 3.6 : 1;

      // Group entries by date
      const byDate = new Map<string, OWM25ForecastEntry[]>();
      for (const e of data.list) {
        const date = toDateStr(e.dt);
        const arr = byDate.get(date);
        if (arr) arr.push(e);
        else byDate.set(date, [e]);
      }

      const result: DailyForecastPoint[] = [];
      for (const [date, entries] of byDate) {
        if (result.length >= days) break;
        let tMin = Infinity;
        let tMax = -Infinity;
        let precipSum = 0;
        let windMax = 0;
        let dominantCode = 800;
        let maxPop = 0;

        for (const e of entries) {
          if (e.main.temp < tMin) tMin = e.main.temp;
          if (e.main.temp > tMax) tMax = e.main.temp;
          precipSum += (e.rain?.["3h"] ?? 0) + (e.snow?.["3h"] ?? 0);
          const ws = e.wind.speed * windMul;
          if (ws > windMax) windMax = ws;
          if (e.pop > maxPop) {
            maxPop = e.pop;
            dominantCode = e.weather[0]?.id ?? 800;
          }
        }

        result.push({
          date,
          weatherCode: owmIdToWmo(dominantCode),
          temperatureMax: tMax,
          temperatureMin: tMin,
          precipitationSum: precipSum,
          windSpeedMax: windMax,
        });
      }

      return result;
    },
  };

  ctx.registerProvider("weather", provider);
}
