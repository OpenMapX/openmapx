import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  LngLat,
  WeatherForecastResponse,
  WeatherOptions,
  WeatherResponse,
} from "@openmapx/core";
import {
  asModifiedContributors,
  type ContributingRecord,
  captureIntegrationContributorCatalogue,
  captureResultContributors,
  contributorsForRecords,
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
        const resolved = resolveCapturedContributors(catalogue, integrationId, {
          contributors: response.contributors,
          sourceIds: [response.source],
        });
        const contributors = provider.changesSourceData
          ? asModifiedContributors(resolved)
          : resolved;
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
  ): Promise<WeatherForecastResponse<HourlyForecastPoint>> {
    for (const { provider, integrationId } of await eligibleProviders()) {
      if (!provider.getHourlyForecast) continue;
      try {
        const catalogue = captureIntegrationContributorCatalogue(ctx, "weather");
        const response = await provider.getHourlyForecast(coords, hours, options);
        // An adapter may identify its serving feed only in the response.
        if (response.source && (await ctx.getDisallowedSourceIds?.())?.has(response.source))
          continue;
        return captureForecast(response, catalogue, integrationId, provider.changesSourceData);
      } catch {
        // fall through
      }
    }
    return { source: null, points: [], contributors: [] };
  }

  async function getDailyForecast(
    coords: LngLat,
    days: number,
    options?: WeatherOptions,
  ): Promise<WeatherForecastResponse<DailyForecastPoint>> {
    for (const { provider, integrationId } of await eligibleProviders()) {
      if (!provider.getDailyForecast) continue;
      try {
        const catalogue = captureIntegrationContributorCatalogue(ctx, "weather");
        const response = await provider.getDailyForecast(coords, days, options);
        if (response.source && (await ctx.getDisallowedSourceIds?.())?.has(response.source))
          continue;
        return captureForecast(response, catalogue, integrationId, provider.changesSourceData);
      } catch {
        // fall through
      }
    }
    return { source: null, points: [], contributors: [] };
  }

  function captureForecast<T extends ContributingRecord>(
    response: WeatherForecastResponse<T>,
    catalogue: ReturnType<typeof captureIntegrationContributorCatalogue>,
    integrationId: string,
    changesSourceData = false,
  ): WeatherForecastResponse<T> {
    const resolved = resolveCapturedContributors(catalogue, integrationId, {
      contributors: response.contributors,
      sourceIds: response.source === null ? [] : [response.source],
    });
    const envelope = changesSourceData ? asModifiedContributors(resolved) : resolved;
    const points = response.points.map((point) =>
      withContributors(point, captureResultContributors(point, envelope)),
    );
    return withContributors({ ...response, points }, contributorsForRecords(points));
  }

  return { getCurrentWeather, getHourlyForecast, getDailyForecast };
}
