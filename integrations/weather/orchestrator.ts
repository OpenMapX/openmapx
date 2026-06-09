import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { WeatherProvider } from "./types.js";

export function createWeatherOrchestrator(ctx: IntegrationContext) {
  function getProviders(): WeatherProvider[] {
    const integrations = ctx.getIntegrationsByDomain("weather");
    const result: WeatherProvider[] = [];

    for (const integration of integrations) {
      const ps = (integration.providers.get("weather") ?? []) as WeatherProvider[];
      for (const provider of ps) {
        result.push(provider);
      }
    }

    result.sort((a, b) => a.priority - b.priority);
    return result;
  }

  /**
   * Providers in priority order, minus any whose source the operator's data-use
   * policy currently disallows (a provider's `id` is its `dataSources` sourceId).
   * The fallback loops walk this list, so a gated provider is skipped and the
   * next eligible one is tried — exactly like an erroring provider.
   */
  async function eligibleProviders(): Promise<WeatherProvider[]> {
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    return getProviders().filter((p) => !disallowed.has(p.id));
  }

  async function getCurrentWeather(
    coords: LngLat,
    options?: WeatherOptions,
  ): Promise<WeatherResponse | null> {
    for (const provider of await eligibleProviders()) {
      try {
        return await provider.getCurrentWeather(coords, options);
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
    for (const provider of await eligibleProviders()) {
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
    for (const provider of await eligibleProviders()) {
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
