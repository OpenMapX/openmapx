import type { SearchSuggestionProviderResult, SearchSuggestionQuery } from "@openmapx/core";

export interface SearchSuggestionProvider {
  readonly id: string;
  searchSuggestions(query: SearchSuggestionQuery): Promise<SearchSuggestionProviderResult>;
}
