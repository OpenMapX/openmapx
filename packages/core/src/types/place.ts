import type { DataSourceDetail } from "./dataSource";
import type { LngLat } from "./geometry";

export interface PlacePhoto {
  url: string;
  thumbnailUrl?: string;
  attribution: string;
  source: string;
  author?: string;
  authorUrl?: string;
  license?: string;
  licenseUrl?: string;
  pageUrl?: string;
  capturedAt?: string;
  /** Photo-specific coordinates [lng, lat] — used for minimap in gallery. */
  coordinates?: LngLat;
}

export interface PlaceFact {
  label: string;
  value: string;
}

export interface PlaceReviewLink {
  platform: string;
  url: string;
}

export interface Place {
  id: string;
  name: string;
  address: string;
  city?: string;
  coordinates: LngLat;
  category?: string;
  /** Raw category string from the geocoding provider (e.g. "railway/station", "highway/bus_stop"). */
  rawCategory?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  rating?: number;
  reviewCount?: number;
  osmTags?: Record<string, string>;
  photos?: PlacePhoto[];
  description?: string;
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  reviewLinks?: PlaceReviewLink[];
  isOpen?: boolean;
  dataSourceDetail?: DataSourceDetail;
}
