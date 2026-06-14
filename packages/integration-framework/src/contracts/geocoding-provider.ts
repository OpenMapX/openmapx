import type { LngLat } from "@openmapx/core";
import type { TransitStop } from "@openmapx/mobility-core/transit";

export interface SearchResult {
  id: string;
  label: string;
  coordinates: LngLat;
  type: "address" | "poi" | "street" | "region";
  confidence: number;
  /** Raw category string from the geocoding provider (e.g. "transit_station", "railway/station"). */
  rawCategory?: string;
  /**
   * Integration ID of the geocoder that actually produced this result (e.g.
   * "geocoding-maptiler"). Tagged by the orchestrator so attribution can credit
   * the served provider rather than every geocoder in the configured chain.
   * See `integrations/geocoding/orchestrator.ts`.
   */
  provider?: string;
}

export interface ReverseGeocodingResult {
  address: string;
  city: string;
  /** Integration ID of the geocoder that produced this result (see `SearchResult.provider`). */
  provider?: string;
}

export interface AutocompleteResult {
  id: string;
  label: string;
  sublabel?: string;
  coordinates?: LngLat;
  type:
    | "address"
    | "poi"
    | "street"
    | "region"
    | "category"
    | "transit_stop"
    | "labeled_place"
    | "nlp_search";
  /** SVG path `d` attribute for the icon (used for category suggestions). */
  iconPath?: string;
  /** iD preset icon key (e.g. "maki-ice-cream", "temaki-helicopter").
   *  When present, render via PresetIcon instead of iconPath. */
  presetIconKey?: string;
  /** Full transit stop data (only when type is "transit_stop"). */
  transitStop?: TransitStop;
  /** Raw category string from the geocoding provider (e.g. "railway/station", "highway/bus_stop"). */
  rawCategory?: string;
  /** Label key for labeled places (e.g. "home", "work", or custom). */
  labelKey?: string;
  /** Parsed intent, present only when type is "nlp_search". */
  nlpIntent?: import("./search-nlp-provider").SearchIntent;
  /**
   * Integration ID of the geocoder that actually produced this suggestion (e.g.
   * "geocoding-photon"). Tagged by the orchestrator so attribution can credit
   * the served provider rather than every geocoder in the configured chain.
   * See `integrations/geocoding/orchestrator.ts`.
   */
  provider?: string;
}

export interface GeocodingProvider {
  geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]>;
  autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}
