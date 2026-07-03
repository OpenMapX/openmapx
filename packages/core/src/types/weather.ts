import type { LngLat } from "./geometry";

export interface WeatherOptions {
  lang?: string;
  units?: "metric" | "imperial";
}

export interface CurrentWeather {
  temperature: number;
  feelsLike: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  windDirection: number;
  windGusts?: number;
  precipitation: number;
  cloudCover: number;
  weatherCode: number;
  isDay: boolean;
  time: string;
}

export interface HourlyForecastPoint {
  time: string;
  temperature: number;
  weatherCode: number;
  precipitationProbability: number;
  precipitation: number;
  windSpeed: number;
  windDirection: number;
  cloudCover: number;
  pressure: number;
}

export interface DailyForecastPoint {
  date: string;
  weatherCode: number;
  temperatureMax: number;
  temperatureMin: number;
  precipitationSum: number;
  windSpeedMax: number;
  sunrise?: string;
  sunset?: string;
}

export interface WeatherResponse {
  location: LngLat;
  current: CurrentWeather;
  hourly?: HourlyForecastPoint[];
  daily?: DailyForecastPoint[];
  source: string;
}

export interface RadarFrame {
  time: number;
  path: string;
}

export interface RadarMeta {
  host: string;
  past: RadarFrame[];
  nowcast: RadarFrame[];
}

export type WeatherSubLayer =
  | "radar"
  | "temperature"
  | "clouds"
  | "wind"
  | "pressure"
  | "precipitation";

export type TemperatureUnit = "celsius" | "fahrenheit";
export type WindSpeedUnit = "kmh" | "mph" | "ms" | "knots";
