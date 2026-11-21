import { CELL_ZOOM } from "./wire";

const MAX_LATITUDE = 85.0511287798;

/** Inclusive z12 tile ranges of a west/south/east/north box, or null for an invalid box. */
export function cellRange(
  bounds: readonly [number, number, number, number],
): { x0: number; x1: number; y0: number; y1: number } | null {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || west > east || south > north)
    return null;
  const n = 2 ** CELL_ZOOM;
  const x = (lng: number) => Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
  const y = (lat: number) => {
    const rad = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180;
    return Math.min(
      n - 1,
      Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n)),
    );
  };
  return { x0: x(west), x1: x(east), y0: y(north), y1: y(south) };
}

/**
 * The z12 cells (`x/y`) a box touches, or none when the box is invalid or
 * would span more than `maxCells` cells.
 */
export function cellsForBounds(
  bounds: readonly [number, number, number, number],
  maxCells: number,
): string[] {
  const range = cellRange(bounds);
  if (!range) return [];
  const { x0, x1, y0, y1 } = range;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxCells) return [];
  const cells: string[] = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) cells.push(`${x}/${y}`);
  return cells;
}
