import {
  type CapturedContributorCatalogue,
  captureIntegrationContributorCatalogue,
  collectOrderedProviders,
  type IntegrationContext,
  type OrderedProvider,
  resolveCapturedContributors,
  UNLISTED_BY_DOMAIN,
} from "@openmapx/integration-framework";
import { type ContributingRecord, withContributors } from "@openmapx/mobility-core/contributors";
import type { GeocodingProvider } from "@openmapx/provider-kit/geocoding";

/**
 * Selected entries already warned about, per context. A reload builds new
 * contexts, so each reload warns once about each entry it cannot serve.
 */
const warnedEntries = new WeakMap<IntegrationContext, Set<string>>();

/**
 * The operator's selection of geocoders, in order: only listed integrations
 * are asked. The registered providers are used as they are, never copied.
 */
function selectedChain(ctx: IntegrationContext): OrderedProvider<GeocodingProvider>[] {
  const chain = collectOrderedProviders<GeocodingProvider>(ctx, "geocoding", {
    unlisted: UNLISTED_BY_DOMAIN.geocoding,
  });
  const served = new Set(chain.map((entry) => entry.integrationId));
  const missing = ctx.getProviderOrder("geocoding").filter((id) => !served.has(id));
  if (missing.length > 0) {
    let warned = warnedEntries.get(ctx);
    if (!warned) {
      warned = new Set();
      warnedEntries.set(ctx, warned);
    }
    for (const id of missing) {
      if (warned.has(id)) continue;
      warned.add(id);
      ctx.log.warn(
        `geocoding provider order names "${id}", which is not a loaded geocoder; skipping it`,
      );
    }
  }
  if (chain.length === 0) throw new Error("No geocoding provider is selected and loaded");
  return chain;
}

/**
 * Stamp each result with the integration ID of the geocoder that produced it.
 * This travels with the data through the response and the Redis/in-memory
 * caches, so downstream attribution credits the served provider rather than
 * every provider in the chain — and being carried per-item it is immune to the
 * cross-request races a shared "last provider" field would suffer. Only fills
 * the tag when absent so a pre-tagging provider wins.
 */
function tagProvider<T extends ContributingRecord & { provider?: string; sourceIds?: string[] }>(
  catalogue: CapturedContributorCatalogue,
  results: T[],
  integrationId: string,
): T[] {
  return results.map((record) => tagRecord(catalogue, record, integrationId));
}

function tagRecord<T extends ContributingRecord & { provider?: string; sourceIds?: string[] }>(
  catalogue: CapturedContributorCatalogue,
  record: T,
  integrationId: string,
): T {
  const provider = record.provider ?? integrationId;
  const declared = catalogue.declaredByIntegration.get(provider) ?? [];
  const tagged = { ...record, provider };
  if (record.contributors === undefined && declared.length === 0 && !catalogue.hasRuntime)
    return tagged;
  const contributors = resolveCapturedContributors(catalogue, provider, record, true);
  return withContributors(tagged, contributors);
}

/**
 * Returns a GeocodingProvider that tries the operator's selected geocoders in
 * order (the geocoding integration's `providerOrder`, by integration id). The
 * first one with results answers; an error moves on to the next, and the last
 * one's error is thrown.
 *
 * The selection is resolved at call time, so a call fails with "No geocoding
 * provider is selected and loaded" when none of it is loaded. Each result
 * carries a `provider` tag (the serving integration ID) via tagProvider.
 */
export function getGeocodingProvider(ctx: IntegrationContext): GeocodingProvider {
  return {
    async geocode(query, lang, proximity) {
      const chain = selectedChain(ctx);
      for (const [i, { provider, integrationId }] of chain.entries()) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const results = await provider.geocode(query, lang, proximity);
          if (results.length > 0) return tagProvider(catalogue, results, integrationId);
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async autocomplete(query, lang, bias) {
      const chain = selectedChain(ctx);
      for (const [i, { provider, integrationId }] of chain.entries()) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const results = await provider.autocomplete(query, lang, bias);
          if (results.length > 0) return tagProvider(catalogue, results, integrationId);
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async reverseGeocode(lat, lng, lang) {
      const chain = selectedChain(ctx);
      for (const [i, { provider, integrationId }] of chain.entries()) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const result = await provider.reverseGeocode(lat, lng, lang);
          if (result) return tagRecord(catalogue, result, integrationId);
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return null;
    },
  };
}
