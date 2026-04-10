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

export interface GeocodingProviderWithMeta extends GeocodingProvider {
  /** Integration ID of the last provider that produced results. */
  lastProvider?: string;
}

let cached: GeocodingProviderWithMeta | null = null;

/**
 * Returns a GeocodingProvider that tries each configured provider in order.
 *
 * GEOCODING_PROVIDER accepts a comma-separated list, e.g. "photon,maptiler".
 * The first provider is tried; on failure the next one is used, and so on.
 * A single value (e.g. "maptiler") works as before.
 *
 * Providers are resolved from the integration framework at call time.
 * After each call, `lastProvider` contains the integration ID that produced results.
 */
export function getGeocodingProvider(): GeocodingProviderWithMeta {
  if (cached) return cached;

  const names = parseProviderList();
  const providersByIntegration = collectProviders();

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
    const self: GeocodingProviderWithMeta = {
      ...single.provider,
      lastProvider: single.integrationId,
      async geocode(query, lang) {
        self.lastProvider = single.integrationId;
        return single.provider.geocode(query, lang);
      },
      async autocomplete(query, lang) {
        self.lastProvider = single.integrationId;
        return single.provider.autocomplete(query, lang);
      },
      async reverseGeocode(lat, lng, lang) {
        self.lastProvider = single.integrationId;
        return single.provider.reverseGeocode(lat, lng, lang);
      },
    };
    cached = self;
    return cached;
  }

  const self: GeocodingProviderWithMeta = {
    lastProvider: chain[0].integrationId,
    async geocode(query, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const results = await chain[i].provider.geocode(query, lang);
          if (results.length > 0) {
            self.lastProvider = chain[i].integrationId;
            return results;
          }
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async autocomplete(query, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const results = await chain[i].provider.autocomplete(query, lang);
          if (results.length > 0) {
            self.lastProvider = chain[i].integrationId;
            return results;
          }
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return [];
    },
    async reverseGeocode(lat, lng, lang) {
      for (let i = 0; i < chain.length; i++) {
        try {
          const result = await chain[i].provider.reverseGeocode(lat, lng, lang);
          if (result) {
            self.lastProvider = chain[i].integrationId;
            return result;
          }
        } catch (err) {
          if (i === chain.length - 1) throw err;
        }
      }
      return null;
    },
  };
  cached = self;

  return cached;
}
