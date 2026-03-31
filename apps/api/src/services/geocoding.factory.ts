import { getIntegrationsByDomain } from "../integration-host.js";
import type { GeocodingProvider } from "./geocoding.provider";

type ProviderName =
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
  maptiler: "geocoding-maptiler",
  nominatim: "geocoding-nominatim",
  pelias: "geocoding-pelias",
  photon: "geocoding-photon",
  motis: "geocoding-motis",
  transitous: "geocoding-motis",
  "db-ris": "geocoding-db-ris",
};

function collectProviders(): Map<string, GeocodingProvider> {
  const map = new Map<string, GeocodingProvider>();
  const geocodingIntegrations = getIntegrationsByDomain("geocoding");

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

function parseProviderList(): ProviderName[] {
  const raw = process.env.GEOCODING_PROVIDER ?? "maptiler";
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

let cached: GeocodingProvider | null = null;

/**
 * Returns a GeocodingProvider that tries each configured provider in order.
 *
 * GEOCODING_PROVIDER accepts a comma-separated list, e.g. "photon,maptiler".
 * The first provider is tried; on failure the next one is used, and so on.
 * A single value (e.g. "maptiler") works as before.
 *
 * Providers are resolved from the integration framework at call time.
 */
export function getGeocodingProvider(): GeocodingProvider {
  if (cached) return cached;

  const names = parseProviderList();
  const providersByIntegration = collectProviders();

  const chain: GeocodingProvider[] = [];
  for (const name of names) {
    const integrationId = NAME_TO_INTEGRATION[name];
    const provider = providersByIntegration.get(integrationId);
    if (!provider) {
      throw new Error(
        `Geocoding provider "${name}" (integration "${integrationId}") is not loaded. ` +
          `Check that the integration is enabled and its manifest is valid.`,
      );
    }
    chain.push(provider);
  }

  if (chain.length === 1) {
    cached = chain[0];
    return cached;
  }

  cached = {
    async geocode(query, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const results = await chain[i].geocode(query, lang);
          if (results.length > 0) return results;
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async autocomplete(query, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const results = await chain[i].autocomplete(query, lang);
          if (results.length > 0) return results;
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async reverseGeocode(lat, lng, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const result = await chain[i].reverseGeocode(lat, lng, lang);
          if (result) return result;
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return null;
    },
  };

  return cached;
}
