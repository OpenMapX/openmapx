import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";

export type {
  CurrentWeather,
  DailyForecastPoint,
  HourlyForecastPoint,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";

export interface WeatherProvider {
  readonly id: string;
  readonly priority: number;
  /**
   * The service this provider reads documents that it changes the original
   * data (computes values, fills gaps from other sources), so the credit says
   * the data was modified, as a licence asking to keep such a notice requires.
   */
  readonly changesSourceData?: boolean;

  getCurrentWeather(coords: LngLat, options?: WeatherOptions): Promise<WeatherResponse>;

  getHourlyForecast?(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>>;

  getDailyForecast?(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>>;
}
