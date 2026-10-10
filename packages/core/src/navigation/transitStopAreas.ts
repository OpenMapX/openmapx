import type {
  TransitStopArea,
  TransitStopAreaShape,
  TripItinerary,
  TripLeg,
} from "@openmapx/mobility-core/transit";

/**
 * Stops as areas a rider enters, not points they must stand on.
 *
 * A bus stop is the length of a bus; a station platform can be 400 m long and
 * GPS under its roof is poor. Deciding "the rider is at the stop" by distance to
 * one coordinate fails both. This module answers it against the stop's real
 * shape — the platform, else the whole stop place, else a circle sized for the
 * mode — widened by the fix's own accuracy.
 */

type LngLat = [number, number];

/** Most a fix's reported accuracy may widen an area by. */
const MAX_ACCURACY_ALLOWANCE_METERS = 20;
/** Default stop circle where nothing better is known. */
const DEFAULT_STOP_RADIUS_METERS = { local: 25, rail: 50 } as const;
/** How close to a destination that is not a stop counts as arrived. */
export const DESTINATION_RADIUS_METERS = 20;

const RAIL_MODES = new Set(["rail", "subway", "monorail", "funicular"]);

/** Metres per degree, flattened around a reference latitude; fine below a few km. */
function projector(refLat: number) {
  const kx = 111_320 * Math.cos((refLat * Math.PI) / 180);
  const ky = 110_574;
  return (p: LngLat, origin: LngLat): [number, number] => [
    (p[0] - origin[0]) * kx,
    (p[1] - origin[1]) * ky,
  ];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function insideRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Metres from `point` to the shape's geometry, ignoring its buffer; 0 inside a polygon. */
function geometryDistance(shape: TransitStopAreaShape, point: LngLat): number {
  const project = projector(point[1]);
  const p: [number, number] = [0, 0];
  if (shape.type === "point") {
    const q = project(shape.coordinates, point);
    return Math.hypot(q[0], q[1]);
  }
  const coords = shape.coordinates.map((c) => project(c, point));
  if (coords.length === 0) return Number.POSITIVE_INFINITY;
  if (coords.length === 1) return Math.hypot(coords[0][0], coords[0][1]);
  if (shape.type === "polygon" && coords.length >= 3 && insideRing(p, coords)) return 0;
  let best = Number.POSITIVE_INFINITY;
  const closed = shape.type === "polygon";
  const segments = closed ? coords.length : coords.length - 1;
  for (let i = 0; i < segments; i++) {
    best = Math.min(best, segmentDistance(p, coords[i], coords[(i + 1) % coords.length]));
  }
  return best;
}

/** Metres from `point` to the edge of the shape's buffered area; 0 when inside. */
export function stopAreaShapeDistance(shape: TransitStopAreaShape, point: LngLat): number {
  return Math.max(0, geometryDistance(shape, point) - shape.bufferMeters);
}

/** Metres from `point` to the nearest of the shapes; 0 when inside any. */
export function stopAreaDistance(shapes: readonly TransitStopAreaShape[], point: LngLat): number {
  let best = Number.POSITIVE_INFINITY;
  for (const shape of shapes) {
    best = Math.min(best, stopAreaShapeDistance(shape, point));
    if (best === 0) break;
  }
  return best;
}

/** How much a fix of the given accuracy may stand outside an area and still count. */
export function stopAreaTolerance(accuracyMeters: number | undefined): number {
  if (accuracyMeters === undefined || !Number.isFinite(accuracyMeters)) return 0;
  return Math.max(0, Math.min(MAX_ACCURACY_ALLOWANCE_METERS, accuracyMeters));
}

/** Whether a fix lies in the area, allowing for its accuracy. */
export function isWithinStopArea(
  shapes: readonly TransitStopAreaShape[],
  point: LngLat,
  accuracyMeters?: number,
): boolean {
  return shapes.length > 0 && stopAreaDistance(shapes, point) <= stopAreaTolerance(accuracyMeters);
}

/** The circle used for a stop nothing better describes, sized for the vehicle. */
export function defaultStopAreaShape(
  point: LngLat,
  mode: string | undefined,
): TransitStopAreaShape {
  const radius = RAIL_MODES.has(mode ?? "")
    ? DEFAULT_STOP_RADIUS_METERS.rail
    : DEFAULT_STOP_RADIUS_METERS.local;
  return { type: "point", coordinates: point, bufferMeters: radius };
}

/**
 * Convex hull of `[lng, lat]` points (monotone chain), as a closed-free ring.
 * Used to turn a stop place's scattered platforms into one area.
 */
export function convexHull(points: readonly LngLat[]): LngLat[] {
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (unique.length <= 2) return unique;
  const refLat = unique.reduce((sum, p) => sum + p[1], 0) / unique.length;
  const kx = Math.cos((refLat * Math.PI) / 180);
  const cross = (o: LngLat, a: LngLat, b: LngLat) =>
    (a[0] - o[0]) * kx * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]) * kx;
  const lower: LngLat[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: LngLat[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Largest distance in metres between any two of the points. */
export function spanMeters(points: readonly LngLat[]): number {
  let span = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const project = projector(points[i][1]);
      const d = project(points[j], points[i]);
      span = Math.max(span, Math.hypot(d[0], d[1]));
    }
  }
  return span;
}

/** Stop areas keyed by {@link transitStopAreaKey}. */
export type TransitStopAreaIndex = Readonly<Record<string, TransitStopArea | undefined>>;

/**
 * Which stop area a trip's place needs: its stop id and platform together. A
 * station-level id names every platform of the station, so the train a rider
 * arrives on and the one they change to share it — but not their areas.
 */
export function transitStopAreaKey(place: {
  stopId?: string;
  platformCode?: string;
}): string | null {
  return place.stopId ? `${place.stopId}|${place.platformCode ?? ""}` : null;
}

/** The shapes that decide "at this stop" for one end of one leg. */
export interface TransitLegTargets {
  /** Where a transit leg is boarded; null for walk legs. */
  board: readonly TransitStopAreaShape[] | null;
  /** Where the leg ends: its alight stop, the next boarding stop, or the destination. */
  end: readonly TransitStopAreaShape[] | null;
}

function isTransit(leg: TripLeg | undefined): boolean {
  return Boolean(leg?.tripId);
}

function placePoint(place: { lat: number; lng: number }): LngLat {
  return [place.lng, place.lat];
}

/**
 * The most specific known area for a stop, skipping any that already contains
 * `mustStartOutside` — reaching an area you started in proves nothing, which is
 * exactly a transfer between two platforms of one station.
 */
function stopTarget(
  place: { lat: number; lng: number; stopId?: string; platformCode?: string },
  mode: string | undefined,
  areas: TransitStopAreaIndex,
  mustStartOutside?: LngLat,
): TransitStopAreaShape[] | null {
  const key = transitStopAreaKey(place);
  const area = key ? areas[key] : undefined;
  const located = Number.isFinite(place.lat) && Number.isFinite(place.lng);
  const fallback = located ? [defaultStopAreaShape(placePoint(place), mode)] : [];
  const tiers: TransitStopAreaShape[][] = [];
  if (area?.platform.length) tiers.push([...area.platform, ...fallback]);
  if (area?.station.length) tiers.push([...area.station, ...fallback]);
  if (fallback.length > 0) tiers.push(fallback);
  for (const tier of tiers) {
    if (mustStartOutside && stopAreaDistance(tier, mustStartOutside) === 0) continue;
    return tier;
  }
  return null;
}

/**
 * Resolves, for every leg, the area that boards it and the area that ends it.
 * A walk leg that ends where the next ride boards shares that ride's board
 * area, so "reached the stop" and "waiting at the stop" agree.
 */
export function resolveTransitLegTargets(
  itinerary: TripItinerary,
  areas: TransitStopAreaIndex = {},
): TransitLegTargets[] {
  const legs = itinerary.legs ?? [];
  const targets: TransitLegTargets[] = legs.map(() => ({ board: null, end: null }));

  legs.forEach((leg, index) => {
    const next = legs[index + 1];
    if (isTransit(leg)) {
      targets[index].board ??= stopTarget(leg.from, leg.mode, areas);
      targets[index].end = leg.to.stopId ? stopTarget(leg.to, leg.mode, areas) : null;
      return;
    }
    if (isTransit(next) && next.from.stopId) {
      const start = leg.geometry?.coordinates?.[0] as LngLat | undefined;
      const target = stopTarget(next.from, next.mode, areas, start);
      targets[index].end = target;
      targets[index + 1].board = target;
      return;
    }
    if (!next) {
      const located = Number.isFinite(leg.to.lat) && Number.isFinite(leg.to.lng);
      targets[index].end = leg.to.stopId
        ? stopTarget(leg.to, legs[index - 1]?.mode, areas)
        : !located
          ? null
          : [
              {
                type: "point",
                coordinates: placePoint(leg.to),
                bufferMeters: DESTINATION_RADIUS_METERS,
              },
            ];
    }
  });
  return targets;
}

/** One stop area a trip needs, with the key its answer is indexed under. */
export interface TransitStopAreaNeed {
  key: string;
  stopId: string;
  lat: number;
  lng: number;
  name: string;
  platform?: string;
  mode: string;
}

/** The stops whose areas a trip needs: every boarding and alighting platform. */
export function transitStopsNeedingAreas(itinerary: TripItinerary): TransitStopAreaNeed[] {
  const stops = new Map<string, TransitStopAreaNeed>();
  for (const leg of itinerary.legs ?? []) {
    if (!isTransit(leg)) continue;
    for (const place of [leg.from, leg.to]) {
      const key = transitStopAreaKey(place);
      if (!key || !place.stopId || stops.has(key)) continue;
      stops.set(key, {
        key,
        stopId: place.stopId,
        lat: place.lat,
        lng: place.lng,
        name: place.name,
        ...(place.platformCode ? { platform: place.platformCode } : {}),
        mode: leg.mode,
      });
    }
  }
  return [...stops.values()];
}
