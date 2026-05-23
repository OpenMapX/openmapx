import type { LngLat } from "@openmapx/core";

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

export interface WeatherProvider {
  readonly id: string;
  readonly priority: number;

  getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse>;

  getHourlyForecast?(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<HourlyForecastPoint[]>;

  getDailyForecast?(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]>;
}
