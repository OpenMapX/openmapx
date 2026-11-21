import { type BuildingReplacement, itemAt, numberAt } from "@openmapx/core";
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
    while (turnsClockwise(lower, p)) lower.pop();
    lower.push(p);
  }
  const upper: Pair[] = [];
  for (const p of sorted.reverse()) {
    while (turnsClockwise(upper, p)) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Whether the chain's last two points and `p` make no counter-clockwise turn. */
function turnsClockwise(chain: Pair[], p: Pair): boolean {
  const n = chain.length;
  return n >= 2 && cross(itemAt(chain, n - 2), itemAt(chain, n - 1), p) <= 0;
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
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, numberAt(positions, i));
  const ground: Pair[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    if (numberAt(positions, i + 1) <= minY + GROUND_BAND_M)
      ground.push([numberAt(positions, i), numberAt(positions, i + 2)]);
  }
  const hull = convexHull(ground);
  if (hull.length < 3) return null;
  const origin = MercatorCoordinate.fromLngLat([anchor[0], anchor[1]]);
  const s = origin.meterInMercatorCoordinateUnits();
  const ring = hull.map(([east, south]) => {
    const point = new MercatorCoordinate(origin.x + east * s, origin.y + south * s, 0).toLngLat();
    return [point.lng, point.lat];
  });
  ring.push(itemAt(ring, 0));
  return { type: "Polygon", coordinates: [ring] };
}

/** The ring's area; a position without two coordinates makes it NaN, which no hull accepts. */
function ringAreaM2(ring: Position[], lat0: number): number {
  const scaleX = METRES_PER_DEGREE_LAT * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = itemAt(ring, i);
    const b = itemAt(ring, i + 1);
    sum +=
      numberAt(a, 0) * scaleX * numberAt(b, 1) * METRES_PER_DEGREE_LAT -
      numberAt(b, 0) * scaleX * numberAt(a, 1) * METRES_PER_DEGREE_LAT;
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

const KIND = new Map([
  ["node", 1],
  ["way", 2],
  ["relation", 3],
]);

/** Planetiler OpenMapTiles vector-tile feature ids (`osmId * 10 + kind`) for OSM refs. */
export function featureIdsFor(replaces: readonly string[]): number[] {
  return replaces.flatMap((ref) => {
    const [, kind, osmId] = /^(node|way|relation)\/(\d+)$/.exec(ref) ?? [];
    const code = kind === undefined ? undefined : KIND.get(kind);
    if (code === undefined || osmId === undefined) return [];
    return [Number(osmId) * 10 + code];
  });
}

/** The footprint's bounding box; a position without two coordinates is left out. */
function bboxOf(geometry: MultiPolygon): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of geometry.coordinates.flat(2)) {
    if (lng === undefined || lat === undefined) continue;
    box[0] = Math.min(box[0], lng);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lng);
    box[3] = Math.max(box[3], lat);
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
