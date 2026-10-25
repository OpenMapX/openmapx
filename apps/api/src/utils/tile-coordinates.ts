export interface WebMercatorTileCoordinates {
  z: number;
  x: number;
  y: number;
}

const DECIMAL_INTEGER_RE = /^[0-9]+$/;

export function parseWebMercatorTileCoordinates(
  z: string,
  x: string,
  y: string,
  maxZoom: number,
): WebMercatorTileCoordinates | null {
  if (![z, x, y].every((value) => DECIMAL_INTEGER_RE.test(value))) return null;

  const parsed = { z: Number(z), x: Number(x), y: Number(y) };
  if (![parsed.z, parsed.x, parsed.y, maxZoom].every(Number.isSafeInteger)) return null;
  if (maxZoom < 0 || parsed.z > maxZoom) return null;

  const worldWidth = 2 ** parsed.z;
  if (parsed.x >= worldWidth || parsed.y >= worldWidth) return null;
  return parsed;
}
