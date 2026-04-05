import { type Client, createClient } from "@hey-api/client-fetch";
import type { Match } from "@motis-project/motis-client";
import {
  geocode as motisGeocode,
  reverseGeocode as motisReverseGeocode,
} from "@motis-project/motis-client";
import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import { uniqueModes } from "./mode-map.js";

interface GeocodingProviderImpl {
  geocode(query: string, lang?: string): Promise<SearchResult[]>;
  autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}

interface MotisInstance {
  client: Client;
  prefix: string;
  provider: string;
}

const transitousInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.TRANSITOUS_URL ?? "https://api.transitous.org",
  });
  return { client, prefix: "mo:", provider: "transitous" };
})();

const motisLocalInstance: MotisInstance = (() => {
  const client = createClient({
    baseUrl: process.env.MOTIS_URL ?? "http://localhost:8081",
  });
  return { client, prefix: "ms:", provider: "motis-local" };
})();

async function isMotisLocalReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${process.env.MOTIS_URL ?? "http://localhost:8081"}/api/v1/plan`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function preferredMotisClient() {
  return (await isMotisLocalReachable()) ? motisLocalInstance : transitousInstance;
}

function matchToSearchResult(match: Match): SearchResult {
  const type: SearchResult["type"] = match.type === "ADDRESS" ? "address" : "poi";
  return {
    id: match.id,
    label: match.name,
    coordinates: [match.lon, match.lat],
    type,
    confidence: match.score / 100,
    rawCategory: match.category,
  };
}

function matchToAutocompleteResult(
  match: Match,
  instance: { provider: string },
): AutocompleteResult {
  if (match.type === "STOP") {
    const stop = {
      id: match.id,
      name: match.name,
      lat: match.lat,
      lng: match.lon,
      modes: uniqueModes(match.modes ?? []),
      provider: instance.provider,
    };
    return {
      id: match.id,
      label: match.name,
      coordinates: [match.lon, match.lat],
      type: "transit_stop",
      transitStop: stop,
      rawCategory: match.category,
    };
  }

  const type: AutocompleteResult["type"] = match.type === "ADDRESS" ? "address" : "poi";
  return {
    id: match.id,
    label: match.name,
    coordinates: [match.lon, match.lat],
    type,
    rawCategory: match.category,
  };
}

export const motisGeocodingService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    const instance = await preferredMotisClient();
    try {
      const { data } = await motisGeocode({
        client: instance.client,
        query: {
          text: query,
          language: lang ? [lang] : undefined,
        },
      });
      const results = (data ?? []).map(matchToSearchResult);
      if (results.length > 0 || instance === transitousInstance) return results;
    } catch {
      if (instance === transitousInstance) return [];
    }
    // Fall back to Transitous
    try {
      const { data } = await motisGeocode({
        client: transitousInstance.client,
        query: {
          text: query,
          language: lang ? [lang] : undefined,
        },
      });
      return (data ?? []).map(matchToSearchResult);
    } catch {
      return [];
    }
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const instance = await preferredMotisClient();
    try {
      const { data } = await motisGeocode({
        client: instance.client,
        query: {
          text: query,
          language: lang ? [lang] : undefined,
        },
      });
      const results = (data ?? []).map((m) => matchToAutocompleteResult(m, instance));
      if (results.length > 0 || instance === transitousInstance) return results;
    } catch {
      if (instance === transitousInstance) return [];
    }
    // Fall back to Transitous
    try {
      const { data } = await motisGeocode({
        client: transitousInstance.client,
        query: {
          text: query,
          language: lang ? [lang] : undefined,
        },
      });
      return (data ?? []).map((m) => matchToAutocompleteResult(m, transitousInstance));
    } catch {
      return [];
    }
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    _lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const instances = (await isMotisLocalReachable())
      ? [motisLocalInstance, transitousInstance]
      : [transitousInstance];
    for (const inst of instances) {
      try {
        const { data } = await motisReverseGeocode({
          client: inst.client,
          query: { place: `${lat},${lng}` },
        });
        const match = data?.[0];
        if (!match) continue;

        const addressParts = [match.street, match.houseNumber].filter(Boolean);
        const address = addressParts.length > 0 ? addressParts.join(" ") : match.name;
        const defaultArea = match.areas.find((a) => a.default === true);
        const city = defaultArea?.name ?? "";

        return { address, city };
      } catch {
        // Try next instance
      }
    }
    return null;
  },
};
