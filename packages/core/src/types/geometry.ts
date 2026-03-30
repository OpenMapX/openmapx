/** [longitude, latitude] */
export type LngLat = [number, number];

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** [west, south, east, north] bounding box tuple. */
export type BBox = [west: number, south: number, east: number, north: number];
