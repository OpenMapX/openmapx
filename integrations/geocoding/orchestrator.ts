import {
  type CapturedContributorCatalogue,
  captureIntegrationContributorCatalogue,
  type IntegrationContext,
  resolveCapturedContributors,
} from "@openmapx/integration-framework";
import { type ContributingRecord, withContributors } from "@openmapx/mobility-core/contributors";
import type { GeocodingProvider } from "./types.js";

type ProviderName =
  | "entur"
  | "maptiler"
  | "nominatim"
  | "pelias"
  | "photon"
  | "motis"
  | "transitous"
  | "db-ris";

/**
 * Map provider names (as used in GEOCODING_PROVIDER env var) to integration IDs.
 * Most follow the "geocoding-<name>" convention; aliases are listed explicitly.
 */
const NAME_TO_INTEGRATION: Record<ProviderName, string> = {
  entur: "geocoding-entur",
  maptiler: "geocoding-maptiler",
  nominatim: "geocoding-nominatim",
  pelias: "geocoding-pelias",
  photon: "geocoding-photon",
  motis: "geocoding-motis",
  transitous: "geocoding-motis",
  "db-ris": "geocoding-db-ris",
};

function collectProviders(ctx: IntegrationContext): Map<string, GeocodingProvider> {
  const map = new Map<string, GeocodingProvider>();
  const geocodingIntegrations = ctx.getIntegrationsByDomain("geocoding");

  for (const integration of geocodingIntegrations) {
    const providers = (integration.providers.get("geocoding") ?? []) as GeocodingProvider[];
    for (const provider of providers) {
      map.set(integration.id, provider);
    }
  }

  return map;
}

function isProviderName(value: string): value is ProviderName {
  return value in NAME_TO_INTEGRATION;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let configuredProviderList = "maptiler";
export function setConfiguredProviderList(value: string | undefined): void {
  configuredProviderList = value && value.trim().length > 0 ? value : "maptiler";
  // Reset the memoised orchestrator so the next call picks up the new chain.
  cached = null;
}

function parseProviderList(): ProviderName[] {
  const raw = configuredProviderList;
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: ProviderName[] = [];
  for (const name of names) {
    if (!isProviderName(name)) {
      throw new Error(
        `Unknown GEOCODING_PROVIDER: "${name}". Valid options: ${Object.keys(NAME_TO_INTEGRATION).join(", ")}`,
      );
    }
    valid.push(name);
  }
  if (valid.length === 0) {
    throw new Error("GEOCODING_PROVIDER must contain at least one provider");
  }
  return valid;
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
  return results.map((record) => {
    const provider = record.provider ?? integrationId;
    const declared = catalogue.declaredByIntegration.get(provider) ?? [];
    const tagged = { ...record, provider };
    if (record.contributors === undefined && declared.length === 0 && !catalogue.hasRuntime)
      return tagged;
    const contributors = resolveCapturedContributors(catalogue, provider, record, true);
    return withContributors(tagged, contributors);
  });
}

let cached: GeocodingProvider | null = null;

/**
 * Returns a GeocodingProvider that tries each configured provider in order.
 *
 * GEOCODING_PROVIDER accepts a comma-separated list, e.g. "photon,maptiler".
 * The first provider is tried; on failure the next one is used, and so on.
 * A single value (e.g. "maptiler") works as before.
 *
 * Providers are resolved from the integration framework at call time. Each
 * result carries a `provider` tag (the serving integration ID) via tagProvider.
 */
export function getGeocodingProvider(ctx: IntegrationContext): GeocodingProvider {
  if (cached) return cached;

  const names = parseProviderList();
  const providersByIntegration = collectProviders(ctx);

  const chain: { integrationId: string; provider: GeocodingProvider }[] = [];
  for (const name of names) {
    const integrationId = NAME_TO_INTEGRATION[name];
    const provider = providersByIntegration.get(integrationId);
    if (!provider) {
      throw new Error(
        `Geocoding provider "${name}" (integration "${integrationId}") is not loaded. ` +
          `Check that the integration is enabled and its manifest is valid.`,
      );
    }
    chain.push({ integrationId, provider });
  }

  if (chain.length === 1) {
    const single = chain[0];
    cached = {
      ...single.provider,
      async geocode(query, lang, proximity) {
        return tagProvider(
          captureIntegrationContributorCatalogue(ctx, "geocoding"),
          await single.provider.geocode(query, lang, proximity),
          single.integrationId,
        );
      },
      async autocomplete(query, lang, bias) {
        return tagProvider(
          captureIntegrationContributorCatalogue(ctx, "geocoding"),
          await single.provider.autocomplete(query, lang, bias),
          single.integrationId,
        );
      },
      async reverseGeocode(lat, lng, lang) {
        const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
        const result = await single.provider.reverseGeocode(lat, lng, lang);
        return result ? tagProvider(catalogue, [result], single.integrationId)[0] : null;
      },
    };
    return cached;
  }

  cached = {
    async geocode(query, lang, proximity) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const results = await chain[i].provider.geocode(query, lang, proximity);
          if (results.length > 0) return tagProvider(catalogue, results, chain[i].integrationId);
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async autocomplete(query, lang, bias) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const results = await chain[i].provider.autocomplete(query, lang, bias);
          if (results.length > 0) return tagProvider(catalogue, results, chain[i].integrationId);
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async reverseGeocode(lat, lng, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const catalogue = captureIntegrationContributorCatalogue(ctx, "geocoding");
          const result = await chain[i].provider.reverseGeocode(lat, lng, lang);
          if (result) {
            return tagProvider(catalogue, [result], chain[i].integrationId)[0];
          }
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return null;
    },
  };

  return cached;
}
