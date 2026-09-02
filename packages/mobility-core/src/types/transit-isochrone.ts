import type { BBox } from "./geometry.js";
// Extensionless because this is the one runtime import in this directory and the
// web app resolves with `moduleResolution: "bundler"`, which does not map a `.js`
// specifier onto its `.ts` source. Type-only imports are erased before resolution,
// so they keep the package's `.js` convention.
import {
  parseTransitReachabilitySurfaceRequest,
  type TransitReachabilityQuery,
  type TransitReachabilitySource,
} from "./transit-reachability";

export const MAX_TRANSIT_ISOCHRONE_AREA_KM2 = 900;
export const DEFAULT_TRANSIT_ISOCHRONE_MAX_SAMPLES = 2048;
export const TRANSIT_ISOCHRONE_METHOD = "motis-one-to-many-grid" as const;

export interface TransitIsochroneRequest extends TransitReachabilityQuery {
  bbox: BBox;
}

export interface TransitIsochroneSampling {
  /** The bbox actually sampled, after area clamping. */
  bbox: BBox;
  /** Lattice spacing in Web Mercator metres. */
  gridMetres: number;
  /** Ground metres per cell at the bbox centre latitude. */
  resolutionMetres: number;
  nx: number;
  ny: number;
  sampleCount: number;
  unreachableCount: number;
  batchCount: number;
  clippedToBbox: boolean;
}

export interface TransitIsochroneResult {
  queryTime: string;
  source: TransitReachabilitySource;
  method: typeof TRANSIT_ISOCHRONE_METHOD;
  /**
   * Always `sampled`. Distinct from the estimated WebGL field and from an exact
   * point check; the export must never be presented as either.
   */
  accuracy: "sampled";
  datasetEpoch: string | null;
  sampling: TransitIsochroneSampling;
  featureCollection: GeoJSON.FeatureCollection;
}

function bbox(value: unknown): BBox {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError("bbox must be [west, south, east, north]");
  }
  const [west, south, east, north] = value;
  for (const entry of [west, south, east, north]) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new TypeError("bbox values must be finite numbers");
    }
  }
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new RangeError("bbox is outside WGS84 bounds");
  }
  // This also excludes a bbox wrapped across the antimeridian. Splitting rings
  // at ±180 is not implemented, so the rejection is explicit rather than
  // producing geometry that draws across the whole map.
  if (west >= east || south >= north) {
    throw new RangeError("bbox must have west < east and south < north");
  }
  return [west, south, east, north];
}

export function parseTransitIsochroneRequest(value: unknown): TransitIsochroneRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request must be an object");
  }
  const input = value as Record<string, unknown>;
  const query = parseTransitReachabilitySurfaceRequest(input);
  return { ...query, bbox: bbox(input.bbox) };
}
