import type { BuildingReplacement } from "@openmapx/core";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { MercatorCoordinate } from "maplibre-gl";

/** Vertices this close to a model's lowest point outline its base. */
const GROUND_BAND_M = 2;
const MIN_HULL_AREA_M2 = 4;
/** A hull this much larger than the asset's own bounds is not its base. */
const MAX_HULL_TO_BOUNDS = 1.5;
const METRES_PER_DEGREE_LAT = 111_320;

type Pair = [number, number];

function cross(o: Pair, a: Pair, b: Pair): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating the start. */
function convexHull(points: Pair[]): Pair[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const lower: Pair[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2) as Pair, lower.at(-1) as Pair, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pair[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2) as Pair, upper.at(-1) as Pair, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The outline of a model's base: the convex hull of its vertices within 2 m
 * of its lowest point, in WGS84. `positions` are x, y, z triplets in the GLB
 * frame (X east, Y up, Z south, metres from the anchor).
 */
export function derivedHull(
  positions: Float32Array,
  anchor: readonly [number, number],
): Polygon | null {
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i] as number);
  const ground: Pair[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    if ((positions[i + 1] as number) <= minY + GROUND_BAND_M)
      ground.push([positions[i] as number, positions[i + 2] as number]);
  }
  const hull = convexHull(ground);
  if (hull.length < 3) return null;
  const origin = MercatorCoordinate.fromLngLat([anchor[0], anchor[1]]);
  const s = origin.meterInMercatorCoordinateUnits();
  const ring = hull.map(([east, south]) => {
    const point = new MercatorCoordinate(origin.x + east * s, origin.y + south * s, 0).toLngLat();
    return [point.lng, point.lat];
  });
  ring.push(ring[0] as Position);
  return { type: "Polygon", coordinates: [ring] };
}

function ringAreaM2(ring: Position[], lat0: number): number {
  const scaleX = METRES_PER_DEGREE_LAT * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i] as Pair;
    const [bx, by] = ring[i + 1] as Pair;
    sum += ax * scaleX * by * METRES_PER_DEGREE_LAT - bx * scaleX * ay * METRES_PER_DEGREE_LAT;
  }
  return Math.abs(sum / 2);
}

/** Whether a derived hull is plausible: not degenerate, not far beyond the asset's bounds. */
export function acceptableHull(
  hull: Polygon,
  bounds: readonly [number, number, number, number],
): boolean {
  const [west, south, east, north] = bounds;
  const lat0 = (south + north) / 2;
  const hullArea = ringAreaM2(hull.coordinates[0] ?? [], lat0);
  const boundsArea =
    (east - west) *
    METRES_PER_DEGREE_LAT *
    Math.cos((lat0 * Math.PI) / 180) *
    (north - south) *
    METRES_PER_DEGREE_LAT;
  return hullArea >= MIN_HULL_AREA_M2 && hullArea <= boundsArea * MAX_HULL_TO_BOUNDS;
}

const KIND = { node: 1, way: 2, relation: 3 } as const;

/** Planetiler OpenMapTiles vector-tile feature ids (`osmId * 10 + kind`) for OSM refs. */
export function featureIdsFor(replaces: readonly string[]): number[] {
  return replaces.flatMap((ref) => {
    const match = /^(node|way|relation)\/(\d+)$/.exec(ref);
    if (!match) return [];
    return [Number(match[2]) * 10 + KIND[match[1] as keyof typeof KIND]];
  });
}

function bboxOf(geometry: MultiPolygon): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of geometry.coordinates.flat(2)) {
    box[0] = Math.min(box[0], point[0] as number);
    box[1] = Math.min(box[1], point[1] as number);
    box[2] = Math.max(box[2], point[0] as number);
    box[3] = Math.max(box[3], point[1] as number);
  }
  return box;
}

/** What a drawn model publishes so the 3D buildings layer hides what it replaces. */
export function toReplacement(
  id: string,
  footprint: Polygon | MultiPolygon | undefined,
  replaces: readonly string[],
  bounds: readonly [number, number, number, number],
): BuildingReplacement {
  const multi: MultiPolygon | undefined = footprint
    ? footprint.type === "Polygon"
      ? { type: "MultiPolygon", coordinates: [footprint.coordinates] }
      : footprint
    : undefined;
  return {
    id,
    featureIds: featureIdsFor(replaces),
    bbox: multi ? bboxOf(multi) : [bounds[0], bounds[1], bounds[2], bounds[3]],
    ...(multi ? { footprint: multi } : {}),
  };
}
