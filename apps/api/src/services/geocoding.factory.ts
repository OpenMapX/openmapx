import { dbRisGeocodingService } from "./db-ris/index";
import type { GeocodingProvider } from "./geocoding.provider";
import { maptilerGeocodingService } from "./maptiler-geocoding.service";
import { motisGeocodingService } from "./motis-geocoding.service";
import { nominatimService } from "./nominatim.service";
import { peliasService } from "./pelias.service";
import { photonService } from "./photon.service";

type ProviderName =
  | "maptiler"
  | "nominatim"
  | "pelias"
  | "photon"
  | "motis"
  | "transitous"
  | "db-ris";

const providers: Record<ProviderName, GeocodingProvider> = {
  maptiler: maptilerGeocodingService,
  nominatim: nominatimService,
  pelias: peliasService,
  photon: photonService,
  motis: motisGeocodingService,
  transitous: motisGeocodingService,
  "db-ris": dbRisGeocodingService,
};

function isProviderName(value: string): value is ProviderName {
  return value in providers;
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
        `Unknown GEOCODING_PROVIDER: "${name}". Valid options: ${Object.keys(providers).join(", ")}`,
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
 */
export function getGeocodingProvider(): GeocodingProvider {
  if (cached) return cached;

  const names = parseProviderList();

  if (names.length === 1) {
    cached = providers[names[0]];
    return cached;
  }

  const chain = names.map((n) => providers[n]);

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
