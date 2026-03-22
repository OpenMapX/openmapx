import type { Match } from "@motis-project/motis-client";
import {
  geocode as motisGeocode,
  reverseGeocode as motisReverseGeocode,
} from "@motis-project/motis-client";
import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import type { GeocodingProvider } from "./geocoding.provider.js";
import { transitousInstance } from "./motis/instances.js";
import { uniqueModes } from "./motis/mode-map.js";

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

function matchToAutocompleteResult(match: Match): AutocompleteResult {
  if (match.type === "STOP") {
    const stop = {
      id: match.id,
      name: match.name,
      lat: match.lat,
      lng: match.lon,
      modes: uniqueModes(match.modes ?? []),
      provider: transitousInstance.provider,
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

export const motisGeocodingService: GeocodingProvider = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
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
    try {
      const { data } = await motisGeocode({
        client: transitousInstance.client,
        query: {
          text: query,
          language: lang ? [lang] : undefined,
        },
      });
      return (data ?? []).map(matchToAutocompleteResult);
    } catch {
      return [];
    }
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    _lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    try {
      const { data } = await motisReverseGeocode({
        client: transitousInstance.client,
        query: { place: `${lat},${lng}` },
      });
      const match = data?.[0];
      if (!match) return null;

      const addressParts = [match.street, match.houseNumber].filter(Boolean);
      const address = addressParts.length > 0 ? addressParts.join(" ") : match.name;
      const defaultArea = match.areas.find((a) => a.default === true);
      const city = defaultArea?.name ?? "";

      return { address, city };
    } catch {
      return null;
    }
  },
};
