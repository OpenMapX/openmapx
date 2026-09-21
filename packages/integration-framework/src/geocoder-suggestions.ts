import {
  type AutocompleteResult,
  type LngLat,
  normalizeSearchTerm,
  type SearchSuggestion,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { GeocodingProvider } from "./contracts/geocoding-provider.js";
import type { SearchSuggestionProvider } from "./contracts/search-suggestion-provider.js";
import type { Wgs84BoundingBox } from "./geospatial";
import type { ProviderCallContext } from "./provider-execution";

const DEFAULT_FRESHNESS_SECONDS = 3_600;

const IMPORTANCE_BY_TYPE: Partial<Record<AutocompleteResult["type"], number>> = {
  transit_stop: 0.7,
  region: 0.6,
  poi: 0.5,
  street: 0.4,
  address: 0.4,
};

export interface GeocoderSuggestionOptions {
  /** Integration id; stamped on every suggestion as its `provider`. */
  id: string;
  /** The geocoder whose `autocomplete` backs the suggestions. */
  geocoder: GeocodingProvider;
  /** Attribution rows attached whenever at least one suggestion is returned. */
  attributions: () => Attribution[];
  /**
   * Optional coverage gate. When the query carries a proximity that lies
   * outside the returned box the upstream is not called at all, so a regional
   * geocoder with a metered API is never spent on queries anchored elsewhere.
   * Returning `undefined` disables the gate.
   */
  coverage?: () => Wgs84BoundingBox | undefined;
  /** Provider-normalized prominence in 0–1; defaults per result type. */
  importance?: (item: AutocompleteResult) => number;
  freshnessSeconds?: number;
}

function withinBox(point: LngLat, box: Wgs84BoundingBox): boolean {
  const [lng, lat] = point;
  const [west, south, east, north] = box;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function toSuggestion(
  item: AutocompleteResult,
  providerId: string,
  importance: (item: AutocompleteResult) => number,
): SearchSuggestion | null {
  if (!item.coordinates) return null;
  const ids = item.ids ?? item.transitStop?.ids;
  return {
    ...item,
    coordinates: item.coordinates,
    ...(ids ? { ids } : {}),
    searchMatch: {
      kind: "name",
      value: item.label,
      normalized: normalizeSearchTerm(item.label),
    },
    importance: importance(item),
    provider: providerId,
    contributingProviders: [providerId],
  };
}

/**
 * Expose a geocoder's `autocomplete` as a search-suggestion provider so a
 * regional or special-purpose geocoder (Entur, DB RIS, ...) contributes to the
 * ranked, conflated suggestion fan-out instead of only answering when every
 * geocoder ahead of it in the fallback chain came back empty.
 */
export function createGeocoderSuggestionProvider(
  options: GeocoderSuggestionOptions,
): SearchSuggestionProvider {
  const freshnessSeconds = options.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  const importance =
    options.importance ?? ((item: AutocompleteResult) => IMPORTANCE_BY_TYPE[item.type] ?? 0.5);
  const empty = (): SearchSuggestionProviderResult => ({
    suggestions: [],
    attributions: [],
    freshnessSeconds,
  });

  return {
    id: options.id,
    async searchSuggestions(
      query: SearchSuggestionQuery,
      { signal }: ProviderCallContext,
    ): Promise<SearchSuggestionProviderResult> {
      signal.throwIfAborted();
      const box = options.coverage?.();
      if (box && query.proximity && !withinBox(query.proximity, box)) return empty();

      const rows = await options.geocoder.autocomplete(query.query, query.lang);
      signal.throwIfAborted();

      const suggestions: SearchSuggestion[] = [];
      for (const row of rows) {
        const suggestion = toSuggestion(row, options.id, importance);
        if (suggestion) suggestions.push(suggestion);
        if (suggestions.length >= query.limit) break;
      }
      if (suggestions.length === 0) return empty();
      return { suggestions, attributions: options.attributions(), freshnessSeconds };
    },
  };
}
