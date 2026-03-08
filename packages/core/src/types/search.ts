import type { LngLat } from "./geometry";

export interface SearchResult {
  id: string;
  label: string;
  coordinates: LngLat;
  type: "address" | "poi" | "street" | "region";
  confidence: number;
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
  type: "address" | "poi" | "street" | "region" | "category";
  /** SVG path `d` attribute for the icon (used for category suggestions). */
  iconPath?: string;
}
