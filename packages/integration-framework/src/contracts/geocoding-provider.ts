import type {
  AutocompleteResult,
  LngLat,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/core";
import type { ProviderCallContext } from "../provider-execution.js";

export type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";

/**
 * Location hint for autocomplete: rank results near `proximity` higher. `zoom`
 * is the map zoom the user is looking at, letting providers widen or narrow
 * the bias to match. Providers map it to their native parameters or ignore it.
 */
export interface GeocodingBias {
  proximity: LngLat;
  zoom?: number;
}

export interface GeocodingProvider {
  geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]>;
  /** Optional caller context is forwarded to cancellable I/O when supported. */
  autocomplete(
    query: string,
    lang?: string,
    bias?: GeocodingBias,
    context?: Pick<ProviderCallContext, "signal">,
  ): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}
