import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { AutocompleteResult } from "./geocoding";
import type { LngLat } from "./geometry";
import type { Ids } from "./identified";

export type SearchMatchKind =
  | "authoritative_code"
  | "explicit_reference"
  | "explicit_alias"
  | "name"
  | "generated_acronym";

export interface SearchSuggestionMatch {
  kind: SearchMatchKind;
  value: string;
  normalized: string;
  namespace?: string;
}

export interface SearchSuggestion extends AutocompleteResult {
  coordinates: LngLat;
  ids?: Ids;
  searchMatch: SearchSuggestionMatch;
  importance: number;
  provider: string;
  contributingProviders?: string[];
}

export interface SearchSuggestionQuery {
  query: string;
  lang: string;
  proximity?: LngLat;
  limit: number;
}

export interface SearchSuggestionProviderResult {
  suggestions: SearchSuggestion[];
  attributions: Attribution[];
  freshnessSeconds: number;
}

export interface SearchSuggestionsResponse {
  suggestions: SearchSuggestion[];
  attributions: Attribution[];
  partial: boolean;
}
