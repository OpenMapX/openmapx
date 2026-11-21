/**
 * MapLibre's Earth circumference (radius 6371008.8 m). Duplicated from
 * `@openmapx/core` because worker modules must not import the core barrel; a
 * test keeps the two equal, so paint and objects agree with the 3D frame.
 */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/** Latitude of the centre of tile row `y` at zoom `z`. */
export function tileCentreLat(z: number, y: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Ground metres per tile unit at the centre of tile row `y`. */
export function metresPerUnit(z: number, y: number, extent: number): number {
  return (
    (EARTH_CIRCUMFERENCE_M * Math.cos((tileCentreLat(z, y) * Math.PI) / 180)) / 2 ** z / extent
  );
}
