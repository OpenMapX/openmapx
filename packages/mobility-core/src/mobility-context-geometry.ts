import type { BoundingBox } from "@openmapx/core";

export type MobilityContextGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface MobilityContextRule {
  vehicleTypeIds?: string[] | null;
  rideStartAllowed: boolean;
  rideEndAllowed: boolean;
  rideThroughAllowed: boolean;
  stationParking?: boolean | null;
  maximumSpeedKph?: number | null;
}

export type MobilityZoneClass = "no_ride" | "no_parking" | "no_start" | "parking_hub" | "slow_zone";

type Position = [number, number];
type Polygon = Position[][];
type MultiPolygon = Position[][][];
type Boundary = "west" | "east" | "south" | "north";

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function openRing(ring: Position[]): Position[] {
  return ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])
    ? ring.slice(0, -1)
    : ring.slice();
}

function dedupe(ring: Position[]): Position[] {
  const result: Position[] = [];
  for (const point of ring) {
    if (result.length === 0 || !samePoint(result[result.length - 1], point)) result.push(point);
  }
  return openRing(result);
}

function ringArea(ring: Position[]): number {
  return (
    ring.reduce((area, point, index) => {
      const next = ring[(index + 1) % ring.length];
      return area + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2
  );
}

function closeValidRing(ring: Position[]): Position[] | null {
  const normalized = dedupe(openRing(ring));
  if (normalized.length < 3 || Math.abs(ringArea(normalized)) < 1e-10) return null;
  return [...normalized, [normalized[0][0], normalized[0][1]]];
}

function parseRing(value: unknown): Position[] | null {
  if (!Array.isArray(value)) return null;
  const result: Position[] = [];
  for (const raw of value) {
    if (
      !Array.isArray(raw) ||
      raw.length < 2 ||
      typeof raw[0] !== "number" ||
      typeof raw[1] !== "number" ||
      !Number.isFinite(raw[0]) ||
      !Number.isFinite(raw[1])
    ) {
      return null;
    }
    result.push([raw[0], raw[1]]);
  }
  return result.length > 0 ? openRing(result) : null;
}

function parsePolygon(value: unknown): Polygon | null {
  if (!Array.isArray(value)) return null;
  const rings = value.map(parseRing).filter((ring): ring is Position[] => ring !== null);
  return rings.length > 0 ? rings : null;
}

function parseGeometry(geometry: {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
}): MultiPolygon | null {
  if (geometry.type === "Polygon") {
    const polygon = parsePolygon(geometry.coordinates);
    return polygon ? [polygon] : null;
  }
  if (!Array.isArray(geometry.coordinates)) return null;
  const polygons = geometry.coordinates
    .map(parsePolygon)
    .filter((polygon): polygon is Polygon => polygon !== null);
  return polygons.length > 0 ? polygons : null;
}

function inside(point: Position, bbox: BoundingBox, boundary: Boundary): boolean {
  if (boundary === "west") return point[0] >= bbox.west;
  if (boundary === "east") return point[0] <= bbox.east;
  if (boundary === "south") return point[1] >= bbox.south;
  return point[1] <= bbox.north;
}

function intersection(
  start: Position,
  end: Position,
  bbox: BoundingBox,
  boundary: Boundary,
): Position {
  const [x1, y1] = start;
  const [x2, y2] = end;
  if (boundary === "west" || boundary === "east") {
    const x = boundary === "west" ? bbox.west : bbox.east;
    const t = x1 === x2 ? 0 : (x - x1) / (x2 - x1);
    return [x, Math.min(bbox.north, Math.max(bbox.south, y1 + (y2 - y1) * t))];
  }
  const y = boundary === "south" ? bbox.south : bbox.north;
  const t = y1 === y2 ? 0 : (y - y1) / (y2 - y1);
  return [Math.min(bbox.east, Math.max(bbox.west, x1 + (x2 - x1) * t)), y];
}

function clipBoundary(ring: Position[], bbox: BoundingBox, boundary: Boundary): Position[] {
  if (ring.length === 0) return [];
  const output: Position[] = [];
  let previous = ring[ring.length - 1];
  let previousInside = inside(previous, bbox, boundary);
  for (const current of ring) {
    const currentInside = inside(current, bbox, boundary);
    if (currentInside) {
      if (!previousInside) output.push(intersection(previous, current, bbox, boundary));
      output.push(current);
    } else if (previousInside) {
      output.push(intersection(previous, current, bbox, boundary));
    }
    previous = current;
    previousInside = currentInside;
  }
  return dedupe(output);
}

function clipRing(ring: Position[], bbox: BoundingBox): Position[] | null {
  let clipped = openRing(ring);
  for (const boundary of ["west", "east", "south", "north"] as const) {
    clipped = clipBoundary(clipped, bbox, boundary);
    if (clipped.length === 0) return null;
  }
  return closeValidRing(clipped);
}

function clipPolygon(polygon: Polygon, bbox: BoundingBox): Polygon | null {
  const outer = polygon[0] ? clipRing(polygon[0], bbox) : null;
  if (!outer) return null;
  const holes = polygon
    .slice(1)
    .map((ring) => clipRing(ring, bbox))
    .filter((ring): ring is Position[] => ring !== null);
  return [outer, ...holes];
}

export function normalizeAndClipMobilityGeometry(
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown },
  bbox: BoundingBox,
): MobilityContextGeometry | null {
  const polygons = parseGeometry(geometry);
  if (!polygons) return null;
  const clipped = polygons
    .map((polygon) => clipPolygon(polygon, bbox))
    .filter((polygon): polygon is Polygon => polygon !== null);
  if (clipped.length === 0) return null;
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: clipped[0] }
    : { type: "MultiPolygon", coordinates: clipped };
}

export function applicableMobilityRules<T extends MobilityContextRule>(
  rules: Array<T | null> | null | undefined,
  selectedTypeIds: ReadonlySet<string>,
): T[] {
  const present = (rules ?? []).filter((rule): rule is T => rule !== null);
  if (selectedTypeIds.size === 0) return present;
  return present.filter(
    (rule) =>
      !rule.vehicleTypeIds ||
      rule.vehicleTypeIds.length === 0 ||
      rule.vehicleTypeIds.some((id) => selectedTypeIds.has(id)),
  );
}

export function classifyMobilityRules(
  rules: MobilityContextRule[],
  slowZoneThresholdKph = 25,
): { zoneClass: MobilityZoneClass; maximumSpeedKph?: number } | null {
  if (rules.length === 0) return null;
  const speeds = rules
    .map((rule) => rule.maximumSpeedKph)
    .filter((speed): speed is number => typeof speed === "number");
  const minimumSpeed = speeds.length > 0 ? Math.min(...speeds) : undefined;
  if (rules.some((rule) => !rule.rideThroughAllowed || rule.maximumSpeedKph === 0)) {
    return { zoneClass: "no_ride", maximumSpeedKph: minimumSpeed };
  }
  if (rules.some((rule) => !rule.rideEndAllowed)) {
    return { zoneClass: "no_parking", maximumSpeedKph: minimumSpeed };
  }
  if (rules.some((rule) => !rule.rideStartAllowed)) {
    return { zoneClass: "no_start", maximumSpeedKph: minimumSpeed };
  }
  if (rules.some((rule) => rule.stationParking === true)) {
    return { zoneClass: "parking_hub", maximumSpeedKph: minimumSpeed };
  }
  return minimumSpeed !== undefined && minimumSpeed < slowZoneThresholdKph
    ? { zoneClass: "slow_zone", maximumSpeedKph: minimumSpeed }
    : null;
}
