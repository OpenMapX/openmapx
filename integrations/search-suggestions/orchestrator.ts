import {
  mergeAutocompleteSuggestions,
  type SearchSuggestion,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
  type SearchSuggestionsResponse,
} from "@openmapx/core";
import {
  type IntegrationContext,
  mapSettledWithConcurrency,
  ProviderCancelledError,
  ProviderTimeoutError,
  runWithProviderDeadline,
  type SearchSuggestionProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

export const PROVIDER_TIMEOUT_MS = 1_200;
export const MAX_PROVIDER_CONCURRENCY = 4;

interface ProviderEntry {
  integrationId: string;
  provider: SearchSuggestionProvider;
}

interface SuccessfulProvider {
  entry: ProviderEntry;
  result: SearchSuggestionProviderResult;
}

function collectProviders(ctx: IntegrationContext): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const integration of ctx.getIntegrationsByDomain("search-suggestions")) {
    const providers = (integration.providers.get("search-suggestions") ??
      []) as SearchSuggestionProvider[];
    for (const provider of providers) entries.push({ integrationId: integration.id, provider });
  }
  return entries;
}

function dedupeAttributions(attributions: Attribution[]): Attribution[] {
  const bySource = new Map<string, Attribution>();
  for (const attribution of attributions) {
    if (!bySource.has(attribution.sourceId)) bySource.set(attribution.sourceId, attribution);
  }
  return [...bySource.values()];
}

async function invokeProvider(
  ctx: IntegrationContext,
  entry: ProviderEntry,
  query: SearchSuggestionQuery,
  signal?: AbortSignal,
): Promise<SuccessfulProvider | null> {
  if (signal?.aborted) throw new ProviderCancelledError();
  const startedAt = Date.now();
  const healthy = (await ctx.providerHealth?.isHealthy(entry.provider.id)) ?? true;
  if (!healthy) {
    ctx.metricsRecorder?.recordProviderCall(
      { providerId: entry.provider.id, method: "searchSuggestions", outcome: "skipped" },
      Date.now() - startedAt,
    );
    throw new Error("search suggestion provider unavailable");
  }

  try {
    const result = await runWithProviderDeadline(
      (providerContext) => entry.provider.searchSuggestions(query, providerContext),
      { signal, timeoutMs: PROVIDER_TIMEOUT_MS },
    );
    const elapsed = Date.now() - startedAt;
    await ctx.providerHealth?.recordSuccess(entry.provider.id, elapsed);
    ctx.metricsRecorder?.recordProviderCall(
      {
        providerId: entry.provider.id,
        method: "searchSuggestions",
        outcome: result.suggestions.length > 0 ? "ok" : "empty",
      },
      elapsed,
    );
    return { entry, result };
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const reason = error instanceof Error ? error.message : "provider error";
    const cancelled = error instanceof ProviderCancelledError;
    const timedOut = error instanceof ProviderTimeoutError;
    if (!cancelled) await ctx.providerHealth?.recordFailure(entry.provider.id, elapsed, reason);
    ctx.metricsRecorder?.recordProviderCall(
      {
        providerId: entry.provider.id,
        method: "searchSuggestions",
        outcome: cancelled ? "cancelled" : timedOut ? "timeout" : "error",
      },
      elapsed,
    );
    throw error;
  }
}

export function createSearchSuggestionsOrchestrator(ctx: IntegrationContext): {
  search(query: SearchSuggestionQuery, signal?: AbortSignal): Promise<SearchSuggestionsResponse>;
} {
  return {
    async search(query, signal) {
      const disallowed = (await ctx.getDisallowedIntegrationIds?.()) ?? new Set<string>();
      const eligible = collectProviders(ctx).filter(
        ({ integrationId }) => integrationId !== ctx.id && !disallowed.has(integrationId),
      );
      const settled = await mapSettledWithConcurrency(eligible, MAX_PROVIDER_CONCURRENCY, (entry) =>
        invokeProvider(ctx, entry, query, signal),
      );
      // Provider fan-out uses all-settled semantics so individual upstream
      // failures can produce a useful partial response. Caller cancellation is
      // different: it must escape as a rejection so cache layers never persist
      // a request-aborted empty result as successful shared data.
      if (signal?.aborted) throw new ProviderCancelledError();
      const successful = settled.flatMap((outcome) =>
        outcome.status === "fulfilled" && outcome.value ? [outcome.value] : [],
      );
      const suggestions: SearchSuggestion[] = successful.flatMap(({ entry, result }) =>
        result.suggestions.map((suggestion) => ({
          ...suggestion,
          provider: suggestion.provider || entry.integrationId,
          contributingProviders:
            suggestion.contributingProviders && suggestion.contributingProviders.length > 0
              ? suggestion.contributingProviders
              : [suggestion.provider || entry.integrationId],
        })),
      );
      const merged = mergeAutocompleteSuggestions(suggestions, query.query, query.proximity).slice(
        0,
        query.limit,
      ) as SearchSuggestion[];
      const contributing = new Set(
        merged.flatMap((suggestion) => suggestion.contributingProviders ?? [suggestion.provider]),
      );
      const attributions = dedupeAttributions(
        successful.flatMap(({ entry, result }) =>
          contributing.has(entry.integrationId) || contributing.has(entry.provider.id)
            ? result.attributions
            : [],
        ),
      );
      return {
        suggestions: merged,
        attributions,
        partial: settled.some((outcome) => outcome.status === "rejected"),
      };
    },
  };
}
