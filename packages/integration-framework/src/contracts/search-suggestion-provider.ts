import type { SearchSuggestionProviderResult, SearchSuggestionQuery } from "@openmapx/core";
import type { ProviderCallContext } from "../provider-execution.js";

export interface SearchSuggestionProvider {
  readonly id: string;
  searchSuggestions(
    query: SearchSuggestionQuery,
    context: ProviderCallContext,
  ): Promise<SearchSuggestionProviderResult>;
}
