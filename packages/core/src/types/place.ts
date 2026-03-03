import type { LngLat } from "./geometry";

export interface PlacePhoto {
  url: string;
  attribution: string;
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
}
