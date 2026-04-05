import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  IntegrationContext,
  LngLat,
  WeatherOptions,
  WeatherProvider,
  WeatherResponse,
} from "@openmapx/core";

const BASE = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 10_000;

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    is_day: number;
    precipitation: number;
    rain: number;
    showers: number;
    snowfall: number;
    weather_code: number;
    cloud_cover: number;
    pressure_msl: number;
    surface_pressure: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weather_code: number[];
    cloud_cover: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    pressure_msl: number[];
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
    sunrise: string[];
    sunset: string[];
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function buildUrl(lat: number, lng: number, options?: WeatherOptions, extra?: string): string {
  const tempUnit = options?.units === "imperial" ? "&temperature_unit=fahrenheit" : "";
  const windUnit = options?.units === "imperial" ? "&wind_speed_unit=mph" : "&wind_speed_unit=kmh";
  const precipUnit = options?.units === "imperial" ? "&precipitation_unit=inch" : "";

  return (
    `${BASE}?latitude=${round4(lat)}&longitude=${round4(lng)}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,` +
    `is_day,precipitation,rain,showers,snowfall,weather_code,` +
    `cloud_cover,pressure_msl,surface_pressure,` +
    `wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&timezone=auto` +
    tempUnit +
    windUnit +
    precipUnit +
    (extra ?? "")
  );
}

async function fetchOpenMeteo(url: string): Promise<OpenMeteoResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "OpenMapX/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    return (await res.json()) as OpenMeteoResponse;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function parseCurrentWeather(data: OpenMeteoResponse, coords: LngLat): WeatherResponse {
  const c = data.current;
  return {
    location: coords,
    current: {
      temperature: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      pressure: c.pressure_msl,
      windSpeed: c.wind_speed_10m,
      windDirection: c.wind_direction_10m,
      windGusts: c.wind_gusts_10m,
      precipitation: c.precipitation,
      cloudCover: c.cloud_cover,
      weatherCode: c.weather_code,
      isDay: c.is_day === 1,
      time: c.time,
    },
    source: "open-meteo",
  };
}

function parseHourly(data: OpenMeteoResponse): HourlyForecastPoint[] {
  const h = data.hourly;
  if (!h) return [];
  return h.time.map((time, i) => ({
    time,
    temperature: h.temperature_2m[i],
    weatherCode: h.weather_code[i],
    precipitationProbability: h.precipitation_probability[i],
    precipitation: h.precipitation[i],
    windSpeed: h.wind_speed_10m[i],
    windDirection: h.wind_direction_10m[i],
    cloudCover: h.cloud_cover[i],
    pressure: h.pressure_msl[i],
  }));
}

function parseDaily(data: OpenMeteoResponse): DailyForecastPoint[] {
  const d = data.daily;
  if (!d) return [];
  return d.time.map((date, i) => ({
    date,
    weatherCode: d.weather_code[i],
    temperatureMax: d.temperature_2m_max[i],
    temperatureMin: d.temperature_2m_min[i],
    precipitationSum: d.precipitation_sum[i],
    windSpeedMax: d.wind_speed_10m_max[i],
    sunrise: d.sunrise[i],
    sunset: d.sunset[i],
  }));
}

const openMeteoProvider: WeatherProvider = {
  id: "open-meteo",
  priority: 10,

  async getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse> {
    const url = buildUrl(coords[1], coords[0], options);
    const data = await fetchOpenMeteo(url);
    return parseCurrentWeather(data, coords);
  },

  async getHourlyForecast(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<HourlyForecastPoint[]> {
    const forecastDays = Math.min(Math.ceil(hours / 24), 7);
    const url = buildUrl(
      coords[1],
      coords[0],
      options,
      `&hourly=temperature_2m,precipitation_probability,precipitation,` +
        `weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,pressure_msl` +
        `&forecast_days=${forecastDays}`,
    );
    const data = await fetchOpenMeteo(url);
    return parseHourly(data).slice(0, hours);
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]> {
    const forecastDays = Math.min(days, 16);
    const url = buildUrl(
      coords[1],
      coords[0],
      options,
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,` +
        `precipitation_sum,wind_speed_10m_max,sunrise,sunset` +
        `&forecast_days=${forecastDays}`,
    );
    const data = await fetchOpenMeteo(url);
    return parseDaily(data).slice(0, days);
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("weather", openMeteoProvider);
}
