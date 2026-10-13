import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import {
  captureIntegrationContributorCatalogue,
  type IntegrationContext,
  resolveCapturedContributors,
  withContributors,
} from "@openmapx/integration-framework";
import type { WeatherProvider } from "./types.js";

export function createWeatherOrchestrator(ctx: IntegrationContext) {
  function getProviders(): Array<{ provider: WeatherProvider; integrationId: string }> {
    const integrations = ctx.getIntegrationsByDomain("weather");
    const result: Array<{ provider: WeatherProvider; integrationId: string }> = [];

    for (const integration of integrations) {
      const ps = (integration.providers.get("weather") ?? []) as WeatherProvider[];
      for (const provider of ps) {
        result.push({ provider, integrationId: integration.id });
      }
    }

    result.sort((a, b) => a.provider.priority - b.provider.priority);
    return result;
  }

  /**
   * Providers in priority order, minus any whose source the operator's data-use
   * policy currently disallows (a provider's `id` is its `dataSources` sourceId).
   * The fallback loops walk this list, so a gated provider is skipped and the
   * next eligible one is tried — exactly like an erroring provider.
   */
  async function eligibleProviders() {
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    return getProviders().filter(({ provider }) => !disallowed.has(provider.id));
  }

  async function getCurrentWeather(
    coords: LngLat,
    options?: WeatherOptions,
  ): Promise<WeatherResponse | null> {
    for (const { provider, integrationId } of await eligibleProviders()) {
      try {
        // Each fallback is a separate acquisition. Its response may identify a
        // runtime feed only after awaiting, so retain the exact lookup now.
        const catalogue = captureIntegrationContributorCatalogue(ctx, "weather");
        const response = await provider.getCurrentWeather(coords, options);
        const contributors = resolveCapturedContributors(catalogue, integrationId, {
          contributors: response.contributors,
          sourceIds: [response.source],
        });
        return withContributors(response, contributors);
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
    for (const { provider } of await eligibleProviders()) {
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
    for (const { provider } of await eligibleProviders()) {
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
