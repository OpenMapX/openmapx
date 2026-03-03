import type { AutocompleteResult, SearchResult } from "@openmapx/core";

export interface GeocodingProvider {
  geocode(query: string): Promise<SearchResult[]>;
  autocomplete(query: string): Promise<AutocompleteResult[]>;
}
