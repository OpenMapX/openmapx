export { normalizeSearchTerm } from "@openmapx/core/search/searchSuggestion";
export type {
  SearchSuggestion,
  SearchSuggestionProviderResult,
  SearchSuggestionQuery,
} from "@openmapx/core/types/searchSuggestion";
export type { SearchSuggestionProvider } from "@openmapx/integration-framework/contracts/search-suggestion-provider";
export { createGeocoderSuggestionProvider } from "@openmapx/integration-framework/geocoder-suggestions";
export type {
  AddressComponents,
  AutocompleteResult,
  GeocodingBias,
  GeocodingProvider,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/provider-kit/geocoding";
export {
  expandSearchQuery,
  fetchWithVariants,
  formatAddress,
  formatStreetLine,
  getQueryVariants,
  lngLatOrNull,
  usableGeocoderRecords,
} from "@openmapx/provider-kit/geocoding";
