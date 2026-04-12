import type { BoundingBox } from "@openmapx/core";
import type { RawWebcam } from "../types.js";

/**
 * Defines a single state DOT camera data source.
 * Implement this interface to add a new state.
 */
export interface StateDotConfig {
  /** Short lowercase state code, e.g. "ny", "or" */
  readonly stateCode: string;
  /** Human-readable label, e.g. "New York" */
  readonly stateName: string;
  /** Source ID used in manifest dataSources, e.g. "dot-ny" */
  readonly sourceId: string;
  /** Rough bounding box for the state (used for fast bbox overlap check) */
  readonly bbox: { south: number; west: number; north: number; east: number };
  /** Whether this adapter needs an API key */
  readonly requiresApiKey: boolean;
  /** Env var name for the API key, if required */
  readonly apiKeyEnvVar?: string;
  /** Fetch all cameras for this state. Returns raw webcams. */
  fetchCameras(): Promise<RawWebcam[]>;
}

export function bboxOverlaps(
  a: BoundingBox,
  b: { south: number; west: number; north: number; east: number },
): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

export function filterByBbox(results: RawWebcam[], bbox: BoundingBox): RawWebcam[] {
  return results.filter((r) => {
    const [lng, lat] = r.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}
