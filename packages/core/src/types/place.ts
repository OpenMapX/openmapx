import type { LngLat } from "./geometry";

export interface Place {
  id: string;
  name: string;
  address: string;
  coordinates: LngLat;
  category?: string;
  phone?: string;
  website?: string;
  openingHours?: string[];
  rating?: number;
  reviewCount?: number;
}
