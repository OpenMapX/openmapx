import type {
  AutocompleteResult,
  LngLat,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/core";

export type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";

export interface GeocodingProvider {
  geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]>;
  autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}
