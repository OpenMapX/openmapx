import type { LngLat } from "./geometry";

export interface SearchResult {
  id: string;
  label: string;
  coordinates: LngLat;
  type: "address" | "poi" | "street" | "region";
  confidence: number;
}

export interface AutocompleteResult {
  id: string;
  label: string;
  sublabel?: string;
  coordinates?: LngLat;
  type: "address" | "poi" | "street" | "region";
}
