import type { BoundingBox, LngLat } from "../types/geometry";
import type { Place } from "../types/place";

export interface PoiSearchResult {
  id: string;
  name: string;
  coordinates: LngLat;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  isOpen?: boolean;
  osmTags?: Record<string, string>;
}

export interface PoiSearchProvider {
  readonly id: string;
  readonly categories: string[];
  search(
    category: string,
    bbox: BoundingBox,
    options?: { lang?: string; filters?: Record<string, unknown> },
  ): Promise<PoiSearchResult[]>;
  getDetail?(poiId: string): Promise<Place | null>;
}
