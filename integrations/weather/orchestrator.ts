import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  IntegrationContext,
  LngLat,
  WeatherAttribution,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import type { WeatherProvider } from "./types.js";

interface ProviderWithAttribution {
  provider: WeatherProvider;
  attribution?: WeatherAttribution;
}

export function createWeatherOrchestrator(ctx: IntegrationContext) {
  function getProviders(): ProviderWithAttribution[] {
    const integrations = ctx.getIntegrationsByDomain("weather");
    const result: ProviderWithAttribution[] = [];

    for (const integration of integrations) {
      const ps = (integration.providers.get("weather") ?? []) as WeatherProvider[];
      const ds = integration.manifest.dataSources?.[0];
      const attribution = ds
        ? { name: ds.name, url: ds.url, license: ds.license, licenseUrl: ds.licenseUrl }
        : undefined;
      for (const provider of ps) {
        result.push({ provider, attribution });
      }
    }

    result.sort((a, b) => a.provider.priority - b.provider.priority);
    return result;
  }

  async function getCurrentWeather(
    coords: LngLat,
    options?: WeatherOptions,
  ): Promise<WeatherResponse | null> {
    for (const { provider, attribution } of getProviders()) {
      try {
        const response = await provider.getCurrentWeather(coords, options);
        if (attribution) response.attribution = attribution;
        return response;
      } catch {
        // fall through to next provider
      }
    }
    return null;
  }

  async function getHourlyForecast(
    coords: LngLat,
    hours: number,
    options?: WeatherOptions,
  ): Promise<HourlyForecastPoint[]> {
    for (const { provider } of getProviders()) {
      if (!provider.getHourlyForecast) continue;
      try {
        return await provider.getHourlyForecast(coords, hours, options);
      } catch {
        // fall through
      }
    }
    return [];
  }

  async function getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<DailyForecastPoint[]> {
    for (const { provider } of getProviders()) {
      if (!provider.getDailyForecast) continue;
      try {
        return await provider.getDailyForecast(coords, days, options);
      } catch {
        // fall through
      }
    }
    return [];
  }

  return { getCurrentWeather, getHourlyForecast, getDailyForecast };
}
