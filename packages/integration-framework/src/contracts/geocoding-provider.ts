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
}

export interface ReverseGeocodingResult {
  address: string;
  city: string;
}

export interface AutocompleteResult {
  id: string;
  label: string;
  sublabel?: string;
  coordinates?: LngLat;
  type: "address" | "poi" | "street" | "region" | "category" | "transit_stop" | "labeled_place";
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
}

export interface GeocodingProvider {
  geocode(query: string, lang?: string): Promise<SearchResult[]>;
  autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]>;
  reverseGeocode(lat: number, lng: number, lang?: string): Promise<ReverseGeocodingResult | null>;
}
