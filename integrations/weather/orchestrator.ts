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
  collectOrderedProviders,
  contributorsForRecords,
  type IntegrationContext,
  resolveCapturedContributors,
  withContributors,
} from "@openmapx/integration-framework";
import type { WeatherProvider } from "@openmapx/provider-kit/weather";

/**
 * The sources a provider answers from. The member comes from installed code
 * the registrar does not shape-check, so a malformed value counts as absent
 * rather than failing every request of the domain. An empty list counts as
 * absent too: every source of an empty list is disallowed vacuously.
 */
function sourcesOf(provider: WeatherProvider): readonly string[] {
  const declared: unknown = provider.sourceIds;
  const ids = Array.isArray(declared)
    ? declared.filter((id): id is string => typeof id === "string")
    : [];
  return ids.length > 0 ? ids : [provider.id];
}

export function createWeatherOrchestrator(ctx: IntegrationContext) {
  /**
   * Providers in the operator's order, minus those the data-use policy
   * disallows: every provider of a disallowed integration, and a provider all
   * of whose sources (`sourceIds`, or its `id`) are disallowed. The fallback
   * loops walk this list, so a gated provider is skipped and the next eligible
   * one is tried, exactly like an erroring provider.
   */
  async function eligibleProviders() {
    const [disallowedSources, disallowedIntegrations] = await Promise.all([
      ctx.getDisallowedSourceIds?.() ?? new Set<string>(),
      ctx.getDisallowedIntegrationIds?.() ?? new Set<string>(),
    ]);
    return collectOrderedProviders<WeatherProvider>(ctx, "weather").filter(
      ({ provider, integrationId }) =>
        !disallowedIntegrations.has(integrationId) &&
        !sourcesOf(provider).every((id) => disallowedSources.has(id)),
    );
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
        // An adapter may identify its serving feed only in the response.
        if (response.source && (await ctx.getDisallowedSourceIds?.())?.has(response.source))
          continue;
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
