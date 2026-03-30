import type { LngLat } from "../types/geometry";
import type { PlacePhoto } from "../types/place";

export interface PhotoProvider {
  readonly id: string;
  getPhotos(
    coords: LngLat,
    options?: { radius?: number; limit?: number; lang?: string },
  ): Promise<PlacePhoto[]>;
}
