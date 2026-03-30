import type { LngLat } from "../types/geometry";

export interface StreetViewImage {
  id: string;
  coordinates: LngLat;
  bearing: number;
  isPano: boolean;
  capturedAt?: string;
  sequenceId?: string;
}

export interface StreetViewProvider {
  readonly id: string;
  getImages(
    coords: LngLat,
    options?: { radius?: number; limit?: number },
  ): Promise<StreetViewImage[]>;
}
