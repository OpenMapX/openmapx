export type {
  AutocompleteResult,
  GeocodingBias,
  GeocodingProvider,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/integration-framework";
export type { AddressComponents } from "./geocoding/format-address.js";
export { formatAddress, formatStreetLine } from "./geocoding/format-address.js";
export {
  expandSearchQuery,
  fetchWithVariants,
  getQueryVariants,
} from "./geocoding/query-expansion.js";
export { lngLatOrNull, usableGeocoderRecords } from "./geocoding/records.js";
