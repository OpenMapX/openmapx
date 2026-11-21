import type { DecodedTile, TileFeature } from "./decode";
import { distanceToPolyline, type Pt, pointInPolygon, ringArea } from "./geometry";
import { hash2, unit } from "./hash";
import { EARTH_CIRCUMFERENCE_M, tileCentreLat } from "./units";

/**
 * Forest planting from the basemap's land cover (spec §5.8) and the shared
 * instance layout for every 3D object.
 */

export type ModelKind = "broadleaf" | "conifer" | "lamp_arm" | "lamp_lantern" | "signal" | "bench";

/**
 * Floats per instance: x, y (metres east and north of the z16 cell's
 * south-west corner), heading (radians, counter-clockwise; 0 means the model's
 * +y faces north), height (m), crown (m), variant, colour jitter, mapped (1 for
 * an OpenStreetMap object, 0 for a planted tree).
 */
export const INSTANCE_STRIDE = 8;

export interface Instances {
  kind: ModelKind;
  count: number;
  data: Float32Array;
}

export const FOREST_SPACING_GROUND_M = 11;
const MAX_JITTER = 0.4;
const ROAD_CLEARANCE_M: Record<string, number> = {
  motorway: 16,
  trunk: 16,
  primary: 12,
  secondary: 9,
  tertiary: 9,
  minor: 5,
  service: 5,
  busway: 5,
  track: 3,
  path: 2,
};
const BUILDING_CLEARANCE_M = 3;
const WATER_CLEARANCE_M = 2;
const SETTLED_LANDUSE = new Set(["residential", "commercial", "industrial", "retail"]);

/**
 * The world-anchored grid spacing in Mercator metres: 11 m on the ground at
 * the centre of the z10 tile containing the cell, so every z16 cell inside a
 * z10 tile shares one grid.
 */
export function forestSpacing(cellY: number): number {
  const lat = tileCentreLat(10, Math.floor(cellY / 64));
  return FOREST_SPACING_GROUND_M / Math.cos((lat * Math.PI) / 180);
}

export class InstanceWriter {
  private readonly rows = new Map<ModelKind, number[]>();

  push(kind: ModelKind, values: readonly number[]): void {
    const list = this.rows.get(kind) ?? [];
    list.push(...values);
    this.rows.set(kind, list);
  }

  finish(): Instances[] {
    return [...this.rows].map(([kind, values]) => ({
      kind,
      count: values.length / INSTANCE_STRIDE,
      data: new Float32Array(values),
    }));
  }
}

interface Polygon {
  outer: Pt[];
  holes: Pt[][];
  box: [number, number, number, number];
}

function boxOf(points: readonly Pt[]): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

/** Group MVT rings into polygons: a positive ring starts one, negative rings are its holes. */
function polygons(features: TileFeature[]): Polygon[] {
  const out: Polygon[] = [];
  for (const feature of features) {
    if (feature.type !== 3) continue;
    let current: Polygon | null = null;
    for (const ring of feature.geometry) {
      if (ring.length < 3) continue;
      if (ringArea(ring) > 0) {
        current = { outer: ring, holes: [], box: boxOf(ring) };
        out.push(current);
      } else if (current) {
        current.holes.push(ring);
      }
    }
  }
  return out;
}

const overlaps = (a: readonly number[], b: readonly number[], margin: number) =>
  (a[0] as number) - margin <= (b[2] as number) &&
  (a[2] as number) + margin >= (b[0] as number) &&
  (a[1] as number) - margin <= (b[3] as number) &&
  (a[3] as number) + margin >= (b[1] as number);

const closed = (ring: Pt[]): Pt[] => [...ring, ring[0] as Pt];

/**
 * Plant a z16 cell's forest: a jittered grid kept inside wood polygons and
 * clear of roads, buildings, water and settled land. `basemap` is the basemap
 * tile `basemapTile` that contains the cell.
 */
export function plantForest(
  basemap: DecodedTile,
  basemapTile: { z: number; x: number; y: number },
  cell: { x: number; y: number },
): Instances[] {
  const extent = basemap.extent;
  const scale = 2 ** (16 - basemapTile.z);
  const lat = tileCentreLat(16, cell.y);
  const cellMetres = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / 2 ** 16;
  const metresPerUnit = (cellMetres * scale) / extent;
  const cellUnits = extent / scale;
  const cellX0 = (cell.x - basemapTile.x * scale) * cellUnits;
  const cellY0 = (cell.y - basemapTile.y * scale) * cellUnits;
  const cellBox = [cellX0, cellY0, cellX0 + cellUnits, cellY0 + cellUnits];

  const near = (list: Polygon[], marginM: number) =>
    list.filter((p) => overlaps(p.box, cellBox, marginM / metresPerUnit));
  const woods = near(
    polygons((basemap.layers.landcover ?? []).filter((f) => f.props.class === "wood")),
    0,
  );
  if (woods.length === 0) return [];
  const settled = near(
    polygons(
      (basemap.layers.landuse ?? []).filter((f) => SETTLED_LANDUSE.has(String(f.props.class))),
    ),
    0,
  );
  const buildings = near(polygons(basemap.layers.building ?? []), BUILDING_CLEARANCE_M);
  const water = near(polygons(basemap.layers.water ?? []), WATER_CLEARANCE_M);
  const roads = (basemap.layers.transportation ?? []).flatMap((feature) => {
    const clearance = ROAD_CLEARANCE_M[String(feature.props.class)];
    if (feature.type !== 2 || clearance === undefined) return [];
    const radius = clearance / metresPerUnit;
    return feature.geometry
      .filter((line) => overlaps(boxOf(line), cellBox, radius))
      .map((line) => ({ line, radius }));
  });

  const blockedBy = (p: Pt, list: Polygon[], marginM: number) => {
    const margin = marginM / metresPerUnit;
    return list.some(
      (polygon) =>
        overlaps(polygon.box, [p[0], p[1], p[0], p[1]], margin) &&
        (pointInPolygon(p, polygon.outer, polygon.holes) ||
          (margin > 0 && distanceToPolyline(p, closed(polygon.outer)).d < margin)),
    );
  };

  const spacing = forestSpacing(cell.y) / EARTH_CIRCUMFERENCE_M;
  const n = 2 ** 16;
  const west = cell.x / n;
  const east = (cell.x + 1) / n;
  const north = cell.y / n;
  const south = (cell.y + 1) / n;
  const reach = MAX_JITTER * spacing;
  const coniferShare = lat > 55 ? 0.6 : 0.3;
  const writer = new InstanceWriter();
  for (
    let i = Math.floor((west - reach) / spacing);
    i <= Math.floor((east + reach) / spacing);
    i++
  ) {
    for (
      let j = Math.floor((north - reach) / spacing);
      j <= Math.floor((south + reach) / spacing);
      j++
    ) {
      const h = hash2(i, j);
      const wx = (i + 0.5 + (unit(h, 0) - 0.5) * 2 * MAX_JITTER) * spacing;
      const wy = (j + 0.5 + (unit(h, 1) - 0.5) * 2 * MAX_JITTER) * spacing;
      if (wx < west || wx >= east || wy < north || wy >= south) continue;
      const p: Pt = [cellX0 + (wx - west) * n * cellUnits, cellY0 + (wy - north) * n * cellUnits];
      if (
        !woods.some(
          (w) =>
            overlaps(w.box, [p[0], p[1], p[0], p[1]], 0) && pointInPolygon(p, w.outer, w.holes),
        )
      )
        continue;
      if (blockedBy(p, settled, 0) || blockedBy(p, buildings, BUILDING_CLEARANCE_M)) continue;
      if (blockedBy(p, water, WATER_CLEARANCE_M)) continue;
      if (roads.some((road) => distanceToPolyline(p, road.line).d < road.radius)) continue;
      const height = 14 + 10 * unit(h, 3);
      writer.push(unit(h, 2) < coniferShare ? "conifer" : "broadleaf", [
        (wx - west) * n * cellMetres,
        (south - wy) * n * cellMetres,
        2 * Math.PI * unit(h, 5),
        height,
        height * (0.45 + 0.15 * unit(h, 4)),
        Math.floor(unit(h, 7) * 4),
        (unit(h, 6) - 0.5) * 0.12,
        0,
      ]);
    }
  }
  return writer.finish();
}
