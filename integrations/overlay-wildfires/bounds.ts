import type { NormalizedViewport } from "./types.js";

const MAX_LAT = 85.051129;
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;
const MIN_LON = -180;
const MAX_LON = 180;

type ViewportQuery = Record<string, string | number | undefined>;

function parseFinite(query: ViewportQuery, key: string): number {
  const value = Number(query[key]);
  if (!Number.isFinite(value)) throw new Error("Invalid bbox");
  return value;
}

function quantizeOutward(value: number, step: number, direction: "floor" | "ceil"): number {
  const scaled = value / step;
  const index = direction === "floor" ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return Number((index * step).toFixed(12));
}

function viewportStep(zoom: number): number {
  if (zoom <= 5) return 0.25;
  if (zoom <= 8) return 0.1;
  return 0.02;
}

export function normalizeViewport(query: ViewportQuery): NormalizedViewport {
  const west = parseFinite(query, "west");
  const south = parseFinite(query, "south");
  const east = parseFinite(query, "east");
  const north = parseFinite(query, "north");
  const rawZoom = parseFinite(query, "zoom");

  if (south > north) throw new Error("Invalid bbox");

  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rawZoom));
  const step = viewportStep(zoom);

  // A normal viewport has east >= west. A wrapped viewport already carries
  // its antimeridian crossing and should retain that relationship while its
  // latitude bounds are expanded and quantized.
  const crossesAntimeridian = west > east;
  const longitudeSpan = crossesAntimeridian ? 360 - west + east : east - west;
  const longitudePadding = Math.max(0, longitudeSpan * 0.1);
  const expandedWest = west - longitudePadding;
  const expandedEast = east + longitudePadding;
  const latitudeSpan = north - south;
  const latitudePadding = Math.max(0, latitudeSpan * 0.1);

  const normalizedWest = Math.max(MIN_LON, Math.min(MAX_LON, expandedWest));
  const normalizedEast = Math.max(MIN_LON, Math.min(MAX_LON, expandedEast));
  const quantizedSouth = Math.max(
    -MAX_LAT,
    Math.min(MAX_LAT, quantizeOutward(south - latitudePadding, step, "floor")),
  );
  const quantizedNorth = Math.max(
    -MAX_LAT,
    Math.min(MAX_LAT, quantizeOutward(north + latitudePadding, step, "ceil")),
  );

  return {
    west: Math.max(MIN_LON, Math.min(MAX_LON, quantizeOutward(normalizedWest, step, "floor"))),
    south: quantizedSouth,
    east: Math.max(MIN_LON, Math.min(MAX_LON, quantizeOutward(normalizedEast, step, "ceil"))),
    north: quantizedNorth,
    zoom,
  };
}

export function splitAntimeridian(bounds: NormalizedViewport): NormalizedViewport[] {
  if (bounds.west <= bounds.east) return [bounds];

  return [
    { ...bounds, east: MAX_LON },
    { ...bounds, west: MIN_LON, east: bounds.east },
  ];
}

export function nifcOffsetForZoom(zoom: number): number {
  if (zoom <= 4) return 0.02;
  if (zoom <= 6) return 0.01;
  if (zoom <= 8) return 0.005;
  return 0.001;
}

export function dedupeByFeatureId(
  collections: GeoJSON.FeatureCollection[],
): GeoJSON.FeatureCollection {
  const seen = new Set<string | number>();
  const features: GeoJSON.Feature[] = [];

  for (const collection of collections) {
    for (const feature of collection.features) {
      if (feature.id === undefined || feature.id === null) {
        features.push(feature);
        continue;
      }
      if (seen.has(feature.id)) continue;
      seen.add(feature.id);
      features.push(feature);
    }
  }

  return { type: "FeatureCollection", features };
}
