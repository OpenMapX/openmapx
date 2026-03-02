/** [longitude, latitude] */
export type LngLat = [number, number];

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}
