import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";

export interface GeocodingProvider {
  geocode(query: string): Promise<SearchResult[]>;
  autocomplete(query: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodingResult | null>;
}
