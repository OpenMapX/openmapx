import type { BoundingBox, LngLat } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";

/**
 * Interface for regional car-sharing operator clients.
 * Each client handles fetching and mapping from one operator's API.
 */
export interface RegionalCarSharingClient {
  /** Unique identifier for this client (e.g., "cambio", "stadtteilauto"). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Geographic regions this client covers (used for bbox pre-filtering). */
  readonly regions: { center: LngLat; radiusKm: number }[];
  /** Attribution for data from this client. */
  readonly attribution: {
    label: string;
    url: string;
    license?: string;
    licenseUrl?: string;
  };
  /** Search for stations within the bounding box. */
  search(bbox: BoundingBox): Promise<SharedMobilityStation[]>;
}

/** Check if a bbox overlaps with any of the client's regions. */
export function clientMatchesBbox(client: RegionalCarSharingClient, bbox: BoundingBox): boolean {
  // Approximate: radiusKm / 111 gives degrees (slightly over-estimates longitude at higher latitudes, which is fine)
  return client.regions.some((r) => {
    const pad = r.radiusKm / 111;
    return (
      r.center[1] >= bbox.south - pad &&
      r.center[1] <= bbox.north + pad &&
      r.center[0] >= bbox.west - pad &&
      r.center[0] <= bbox.east + pad
    );
  });
}
