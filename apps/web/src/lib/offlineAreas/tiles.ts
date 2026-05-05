import type { OfflineAreaBbox } from "./types";

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return Math.floor(((1 - Math.log((1 + sin) / (1 - sin)) / (2 * Math.PI)) / 2) * 2 ** z);
}

export function tilesInBbox(bbox: OfflineAreaBbox, minZoom: number, maxZoom: number): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = Math.max(0, Math.min(lonToTileX(bbox.west, z), lonToTileX(bbox.east, z)));
    const xMax = Math.min(2 ** z - 1, Math.max(lonToTileX(bbox.west, z), lonToTileX(bbox.east, z)));
    const yMin = Math.max(0, Math.min(latToTileY(bbox.north, z), latToTileY(bbox.south, z)));
    const yMax = Math.min(
      2 ** z - 1,
      Math.max(latToTileY(bbox.north, z), latToTileY(bbox.south, z)),
    );
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

export function countTiles(bbox: OfflineAreaBbox, minZoom: number, maxZoom: number): number {
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = Math.min(lonToTileX(bbox.west, z), lonToTileX(bbox.east, z));
    const xMax = Math.max(lonToTileX(bbox.west, z), lonToTileX(bbox.east, z));
    const yMin = Math.min(latToTileY(bbox.north, z), latToTileY(bbox.south, z));
    const yMax = Math.max(latToTileY(bbox.north, z), latToTileY(bbox.south, z));
    count += (xMax - xMin + 1) * (yMax - yMin + 1);
  }
  return count;
}

export function fillTileTemplate(template: string, tile: TileCoord): string {
  return template
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y));
}
