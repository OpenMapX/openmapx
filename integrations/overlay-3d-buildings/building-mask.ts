// Adapted from alexwohlbruck/landmarks web/building-geometry.ts (CC0-1.0),
// https://github.com/alexwohlbruck/landmarks/tree/4d92e9c718f2f6e2ba5ff6c116d880271681614a
import { classifyRings, VectorTile } from "@mapbox/vector-tile";
import { type Feature, fromVectorTileJs, GeoJSONWrapper } from "@maplibre/vt-pbf";
import type { BuildingReplacement } from "@openmapx/core";
import { PbfReader } from "pbf";
import { difference, type Geom, intersection, union } from "polyclip-ts";

export interface TileCoordinate {
  z: number;
  x: number;
  y: number;
}

type Pair = [number, number];
type Ring = Pair[];
type Polygon = Ring[];
type Bounds = [number, number, number, number];

/**
 * Tile quantization and simplification shift vertices by a fraction of a
 * pixel, so a matching footprint rarely covers a building exactly; a component
 * covered this much is the replaced building and is removed whole.
 */
export const COVERAGE_DROP_RATIO = 0.8;

/** Tile-pixel margin within which features near a mask are processed. */
const EDGE_MARGIN = 16;

function lngToX(lng: number, n: number): number {
  return ((lng + 180) / 360) * n;
}

function latToY(lat: number, n: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n;
}

function yToLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

/** West, south, east, north of a tile in WGS84. */
export function tileBounds({ z, x, y }: TileCoordinate): Bounds {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, yToLat(y + 1, n), ((x + 1) / n) * 360 - 180, yToLat(y, n)];
}

const overlaps = (a: Bounds, b: readonly number[]) =>
  a[0] <= (b[2] as number) &&
  a[2] >= (b[0] as number) &&
  a[1] <= (b[3] as number) &&
  a[3] >= (b[1] as number);

/** The replacements whose extent touches a tile. */
export function replacementsForTile(
  tile: TileCoordinate,
  all: readonly BuildingReplacement[],
): BuildingReplacement[] {
  const bounds = tileBounds(tile);
  return all.filter((replacement) => overlaps(bounds, replacement.bbox));
}

function toTilePixel([lng, lat]: readonly number[], tile: TileCoordinate, extent: number): Pair {
  const n = 2 ** tile.z;
  return [
    (lngToX(lng as number, n) - tile.x) * extent,
    (latToY(lat as number, n) - tile.y) * extent,
  ];
}

function boundsToPixels(bbox: readonly number[], tile: TileCoordinate, extent: number): Bounds {
  const [x0, y0] = toTilePixel([bbox[0] as number, bbox[3] as number], tile, extent);
  const [x1, y1] = toTilePixel([bbox[2] as number, bbox[1] as number], tile, extent);
  return [x0, y0, x1, y1];
}

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [px, py] = ring[i] as Pair;
    const [qx, qy] = ring[(i + 1) % ring.length] as Pair;
    sum += px * qy - qx * py;
  }
  return sum / 2;
}

function geometryArea(geometry: Polygon[]): number {
  return geometry.reduce(
    (total, polygon) =>
      total +
      Math.abs(ringArea(polygon[0] ?? [])) -
      polygon.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0),
    0,
  );
}

function polygonBounds(polygon: Polygon): Bounds {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of polygon.flat()) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

/**
 * Work on each polygon component, never on a merged feature as a whole: a
 * merged feature's other components can be buildings blocks away.
 */
function pointInRing([x, y]: Pair, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Pair;
    const [xj, yj] = ring[j] as Pair;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function subtractMasks(
  polygon: Polygon,
  masks: { geometry: Polygon[]; bounds: Bounds }[],
): Polygon[] {
  const box = polygonBounds(polygon);
  const nearby = masks.filter((mask) => overlaps(box, mask.bounds));
  if (nearby.length === 0) return [polygon];
  // Cheap containment first; polygon clipping is reserved for buildings that
  // cross a footprint's edge, which keeps dense tiles fast.
  const outer = polygon[0] ?? [];
  const maskOuters = nearby.flatMap((mask) => mask.geometry.map((part) => part[0] ?? []));
  if (maskOuters.some((ring) => outer.every((point) => pointInRing(point, ring)))) return [];
  const anyInside =
    outer.some((point) => maskOuters.some((ring) => pointInRing(point, ring))) ||
    maskOuters.some((ring) => ring.some((point) => pointInRing(point, outer)));
  if (!anyInside) return [polygon];
  const [first, ...rest] = nearby.map((mask) => mask.geometry as Geom);
  const coverage = rest.length === 0 ? (first as Geom) : union(first as Geom, ...rest);
  const covered = intersection([polygon] as Geom, coverage) as Polygon[];
  if (covered.length === 0) return [polygon];
  if (geometryArea(covered) >= geometryArea([polygon]) * COVERAGE_DROP_RATIO) return [];
  return difference([polygon] as Geom, coverage) as Polygon[];
}

/**
 * Rewrite one building layer so that buildings the replacements stand for
 * disappear: exact feature ids are dropped near their replacement, merged
 * components mostly covered by a footprint are dropped, and partly covered
 * ones are trimmed. Properties, holes and untouched features are kept. The
 * result holds only the named layer.
 */
export function rewriteBuildingTile(
  bytes: Uint8Array,
  tile: TileCoordinate,
  sourceLayer: string,
  replacements: readonly BuildingReplacement[],
): Uint8Array {
  if (replacements.length === 0) return bytes;
  const source = new VectorTile(new PbfReader(bytes)).layers[sourceLayer];
  if (!source) return fromVectorTileJs({ layers: {} });
  const extent = source.extent;
  const tileBox: Bounds = [-EDGE_MARGIN, -EDGE_MARGIN, extent + EDGE_MARGIN, extent + EDGE_MARGIN];

  const masks = replacements
    .flatMap((replacement) => (replacement.footprint ? [replacement.footprint] : []))
    .map((footprint) => {
      const geometry = footprint.coordinates.map((polygon) =>
        polygon.map((ring) => ring.map((point) => toTilePixel(point, tile, extent))),
      );
      return { geometry, bounds: polygonBounds(geometry.flat()) };
    })
    .filter((mask) => overlaps(tileBox, mask.bounds));

  const idBounds = new Map<number, Bounds[]>();
  for (const replacement of replacements) {
    const bounds = boundsToPixels(replacement.bbox, tile, extent);
    for (const id of replacement.featureIds)
      idBounds.set(id, [...(idBounds.get(id) ?? []), bounds]);
  }

  const features: Feature[] = [];
  for (let i = 0; i < source.length; i++) {
    const feature = source.feature(i);
    const polygons: Polygon[] = classifyRings(feature.loadGeometry()).map((polygon) =>
      polygon.map((ring) => ring.map((point): Pair => [point.x, point.y])),
    );
    // Planetiler gives merged features ids ending in 0; only unmerged ids are exact.
    const id = typeof feature.id === "number" ? feature.id : undefined;
    const exact = id !== undefined && id % 10 !== 0 ? idBounds.get(id) : undefined;
    if (exact) {
      const box = polygonBounds(polygons.flat());
      if (exact.some((bounds) => overlaps(bounds, box))) continue;
    }
    for (const polygon of polygons) {
      for (const piece of subtractMasks(polygon, masks)) {
        const geometry = piece
          .map((ring) => ring.map(([x, y]): Pair => [Math.round(x), Math.round(y)]))
          .filter((ring) => ring.length >= 4 && Math.abs(ringArea(ring)) > 0);
        if (geometry.length === 0) continue;
        features.push({
          ...(id === undefined ? {} : { id }),
          type: 3,
          tags: feature.properties,
          geometry,
        } as Feature);
      }
    }
  }
  const layer = new GeoJSONWrapper(features, { version: 2, extent });
  // The encoder writes each layer under its own `name`; the object key is unused.
  layer.name = sourceLayer;
  return fromVectorTileJs({ layers: { masked: layer } });
}
