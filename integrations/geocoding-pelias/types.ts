import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";

export interface GeocodingProviderImpl {
  geocode(query: string, lang?: string): Promise<SearchResult[]>;
  autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}
