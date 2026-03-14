import type { LngLat } from "./geometry";
import type { TransitStop } from "./transit";

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
  type: "address" | "poi" | "street" | "region" | "category" | "transit_stop";
  /** SVG path `d` attribute for the icon (used for category suggestions). */
  iconPath?: string;
  /** Full transit stop data (only when type is "transit_stop"). */
  transitStop?: TransitStop;
  /** Raw category string from the geocoding provider (e.g. "railway/station", "highway/bus_stop"). */
  rawCategory?: string;
}
