import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { fetchJsonWithTimeout, round4 } from "@openmapx/integration-weather/lib";
import type { WeatherProvider } from "@openmapx/integration-weather/types";

const BASE = "https://api.open-meteo.com/v1/forecast";

interface OpenMeteoResponse {
  /** IANA zone the times are local to, resolved from `timezone=auto`. */
  timezone?: string;
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

function fetchOpenMeteo(url: string): Promise<OpenMeteoResponse> {
  return fetchJsonWithTimeout<OpenMeteoResponse>(url, { label: "Open-Meteo" });
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

/** Open-Meteo sends one value per entry of `time` in every column; a short column is a broken answer. */
function columnAt<T>(column: readonly T[], index: number, name: string): T {
  const value = column[index];
  if (value === undefined) throw new Error(`Open-Meteo ${name} is shorter than its time axis`);
  return value;
}

function parseHourly(data: OpenMeteoResponse): HourlyForecastPoint[] {
  const h = data.hourly;
  if (!h) return [];
  return h.time.map((time, i) => ({
    time,
    temperature: columnAt(h.temperature_2m, i, "temperature_2m"),
    weatherCode: columnAt(h.weather_code, i, "weather_code"),
    precipitationProbability: columnAt(h.precipitation_probability, i, "precipitation_probability"),
    precipitation: columnAt(h.precipitation, i, "precipitation"),
    windSpeed: columnAt(h.wind_speed_10m, i, "wind_speed_10m"),
    windDirection: columnAt(h.wind_direction_10m, i, "wind_direction_10m"),
    cloudCover: columnAt(h.cloud_cover, i, "cloud_cover"),
    pressure: columnAt(h.pressure_msl, i, "pressure_msl"),
  }));
}

function parseDaily(data: OpenMeteoResponse): DailyForecastPoint[] {
  const d = data.daily;
  if (!d) return [];
  // `timezone=auto` makes these the location's calendar days, in `timezone`.
  return d.time.map((date, i) => ({
    date,
    ...(data.timezone ? { timeZone: data.timezone } : {}),
    weatherCode: columnAt(d.weather_code, i, "weather_code"),
    temperatureMax: columnAt(d.temperature_2m_max, i, "temperature_2m_max"),
    temperatureMin: columnAt(d.temperature_2m_min, i, "temperature_2m_min"),
    precipitationSum: columnAt(d.precipitation_sum, i, "precipitation_sum"),
    windSpeedMax: columnAt(d.wind_speed_10m_max, i, "wind_speed_10m_max"),
    sunrise: columnAt(d.sunrise, i, "sunrise"),
    sunset: columnAt(d.sunset, i, "sunset"),
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
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>> {
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
    return { source: "open-meteo", points: parseHourly(data).slice(0, hours) };
  },

  async getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>> {
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
    return { source: "open-meteo", points: parseDaily(data).slice(0, days) };
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(openMeteoProvider);
}
