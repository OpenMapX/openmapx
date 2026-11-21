export interface PositionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The extent of GeoJSON positions, read as `[lng, lat, ...]`. A position
 * without both coordinates is skipped; null when none has them.
 */
export function positionBounds(positions: Iterable<readonly number[]>): PositionBounds | null {
  let bounds: PositionBounds | null = null;
  for (const [lng, lat] of positions) {
    if (lng === undefined || lat === undefined) continue;
    if (!bounds) {
      bounds = { west: lng, south: lat, east: lng, north: lat };
      continue;
    }
    if (lng < bounds.west) bounds.west = lng;
    if (lng > bounds.east) bounds.east = lng;
    if (lat < bounds.south) bounds.south = lat;
    if (lat > bounds.north) bounds.north = lat;
  }
  return bounds;
}
