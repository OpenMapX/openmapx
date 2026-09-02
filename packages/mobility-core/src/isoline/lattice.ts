import { fromWebMercator, toWebMercator } from "../mercator.js";
import type { BBox } from "../types/geometry.js";

export const DEFAULT_MAX_SAMPLES = 2048;
export const DEFAULT_MIN_SPACING_METRES = 100;
export const DEFAULT_MAX_AREA_KM2 = 900;

export interface IsochroneLattice {
  /** The bbox actually sampled, after clamping. */
  bbox: BBox;
  /** South-west corner in Web Mercator metres, snapped to a global spacing multiple. */
  originX: number;
  originY: number;
  /** Lattice spacing in Web Mercator metres. */
  spacing: number;
  /** Ground metres per cell at the bbox centre latitude. */
  resolutionMetres: number;
  nx: number;
  ny: number;
  clipped: boolean;
}

/**
 * A sampled travel-time field over a lattice.
 *
 * Declared next to the lattice it indexes so the MOTIS sampler and the transit
 * orchestrator share one definition instead of two structurally identical ones
 * that could drift.
 */
export interface TravelTimeField {
  lattice: IsochroneLattice;
  /** Best travel time in seconds per lattice point, row-major; `null` when unreachable. */
  values: (number | null)[];
  batchCount: number;
  unreachableCount: number;
}

export interface PlanIsochroneLatticeOptions {
  bbox: BBox;
  maxSamples?: number;
  minSpacingMetres?: number;
  maxAreaKm2?: number;
}

/**
 * Approximate ground area of a bbox in square kilometres.
 *
 * Measured on the ground rather than in the projection: Mercator inflates area
 * by 1/cos²(latitude), so a projected budget would silently allow a far larger
 * region near the equator than at high latitude. The `cos²` factor at the
 * centre latitude undoes that so one budget means the same thing everywhere.
 */
function groundAreaKm2(bbox: BBox): number {
  const [west, south, east, north] = bbox;
  const [x0, y0] = toWebMercator(west, south);
  const [x1, y1] = toWebMercator(east, north);
  const centreLatitude = (south + north) / 2;
  const shrink = Math.cos((centreLatitude * Math.PI) / 180) ** 2;
  return (Math.abs(x1 - x0) * Math.abs(y1 - y0) * shrink) / 1_000_000;
}

/**
 * Shrink a bbox around its geographic centre until its projected area fits the
 * budget.
 *
 * The shrink happens in degrees, not in Mercator metres, so the centre the
 * caller asked for stays exactly where it was. Scaling symmetrically in
 * Mercator would move the centre latitude, because Mercator y is non-linear in
 * latitude — a 20-degree tall box centred on 50N would come back centred near
 * 51N. Since Mercator area is not linear in the latitude span either, one
 * scaling pass can overshoot, so this refines until it fits.
 */
function clampArea(bbox: BBox, maxAreaKm2: number): { bbox: BBox; clipped: boolean } {
  if (groundAreaKm2(bbox) <= maxAreaKm2) return { bbox, clipped: false };

  const [west, south, east, north] = bbox;
  const centreLng = (west + east) / 2;
  const centreLat = (south + north) / 2;
  let halfLng = (east - west) / 2;
  let halfLat = (north - south) / 2;

  let current: BBox = bbox;
  for (let pass = 0; pass < 24; pass += 1) {
    const areaKm2 = groundAreaKm2(current);
    if (areaKm2 <= maxAreaKm2) break;
    const scale = Math.sqrt(maxAreaKm2 / areaKm2);
    halfLng *= scale;
    halfLat *= scale;
    current = [
      centreLng - halfLng,
      Math.max(-85, centreLat - halfLat),
      centreLng + halfLng,
      Math.min(85, centreLat + halfLat),
    ];
  }
  return { bbox: current, clipped: true };
}

/**
 * Round spacing up onto a fixed ladder.
 *
 * Two nearby requests with slightly different bboxes would otherwise derive
 * slightly different irrational spacings, land on different lattices, and never
 * share a cached field — which defeats the point of snapping the origin at all.
 * Quantising first makes the spacing, and therefore the whole lattice, stable
 * across small viewport changes.
 */
function quantizeSpacing(raw: number): number {
  const step = raw < 250 ? 10 : raw < 1_000 ? 25 : 100;
  return Math.ceil(raw / step) * step;
}

/**
 * Plan a deterministic square lattice over `bbox`.
 *
 * The origin snaps to a global multiple of the spacing so that two nearby
 * requests at the same budget land on the same grid and can share a cached
 * field instead of sampling nearly identical points twice.
 */
export function planIsochroneLattice(options: PlanIsochroneLatticeOptions): IsochroneLattice {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const minSpacing = options.minSpacingMetres ?? DEFAULT_MIN_SPACING_METRES;
  const { bbox, clipped } = clampArea(options.bbox, options.maxAreaKm2 ?? DEFAULT_MAX_AREA_KM2);

  const [west, south, east, north] = bbox;
  const [x0, y0] = toWebMercator(west, south);
  const [x1, y1] = toWebMercator(east, north);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);

  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const maxX = Math.max(x0, x1);
  const maxY = Math.max(y0, y1);

  // Points sit on cell corners and the origin snaps outward to a global
  // multiple of the spacing, so the corner count is not simply area/spacing².
  // Derive a candidate, then widen along the ladder until the real count fits.
  let spacing = quantizeSpacing(
    Math.max(minSpacing, Math.sqrt((width * height) / Math.max(1, maxSamples))),
  );
  // `ceil + 1`, not `floor + 1`: the last lattice point has to sit at or beyond
  // the far edge, otherwise the strip between the final column and the bbox
  // boundary is never sampled and contours stop short of the requested area.
  let originX = Math.floor(minX / spacing) * spacing;
  let originY = Math.floor(minY / spacing) * spacing;
  let nx = Math.ceil((maxX - originX) / spacing) + 1;
  let ny = Math.ceil((maxY - originY) / spacing) + 1;

  for (let pass = 0; pass < 64 && nx * ny > maxSamples; pass += 1) {
    spacing = quantizeSpacing(spacing + 1);
    originX = Math.floor(minX / spacing) * spacing;
    originY = Math.floor(minY / spacing) * spacing;
    nx = Math.ceil((maxX - originX) / spacing) + 1;
    ny = Math.ceil((maxY - originY) / spacing) + 1;
  }

  const centreLatitude = (south + north) / 2;
  return {
    bbox,
    originX,
    originY,
    spacing,
    resolutionMetres: spacing * Math.cos((centreLatitude * Math.PI) / 180),
    nx,
    ny,
    clipped,
  };
}

/** Row-major lattice point (index 0 is the south-west corner) as `[lng, lat]`. */
export function latticePointAt(lattice: IsochroneLattice, index: number): [number, number] {
  const row = Math.floor(index / lattice.nx);
  const column = index % lattice.nx;
  return fromWebMercator(
    lattice.originX + column * lattice.spacing,
    lattice.originY + row * lattice.spacing,
  );
}
