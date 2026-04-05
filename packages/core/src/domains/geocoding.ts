import type { BoundingBox, LngLat } from "../types/geometry";
import type { Place } from "../types/place";
import type { AutocompleteResult } from "../types/search";

export interface GeocodingProvider {
  readonly id: string;
  readonly priority: number;
  geocode(query: string, options?: { lang?: string; bbox?: BoundingBox }): Promise<Place[]>;
  autocomplete(
    query: string,
    options?: { lang?: string; bbox?: BoundingBox },
  ): Promise<AutocompleteResult[]>;
  reverseGeocode(coords: LngLat, options?: { lang?: string }): Promise<Place | null>;
}
