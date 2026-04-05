import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherAttribution,
  WeatherOptions,
  WeatherProvider,
  WeatherResponse,
} from "@openmapx/core";
import { getIntegrationsByDomain } from "../integration-host.js";

interface ProviderWithAttribution {
  provider: WeatherProvider;
  attribution?: WeatherAttribution;
}

function getProviders(): ProviderWithAttribution[] {
  const integrations = getIntegrationsByDomain("weather");
  const result: ProviderWithAttribution[] = [];

  for (const integration of integrations) {
    const ps = (integration.providers.get("weather") ?? []) as WeatherProvider[];
    const attr = integration.manifest.attribution?.[0];
    const attribution = attr
      ? { name: attr.name, url: attr.url, license: attr.license, licenseUrl: attr.licenseUrl }
      : undefined;
    for (const provider of ps) {
      result.push({ provider, attribution });
    }
  }

  result.sort((a, b) => a.provider.priority - b.provider.priority);
  return result;
}

export async function getCurrentWeather(
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

export async function getHourlyForecast(
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

export async function getDailyForecast(
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
