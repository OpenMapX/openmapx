import type { BoundingBox, LngLat } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { CacheClient } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";

/** What a regional client receives for one search. */
export interface RegionalSearchContext {
  cache: CacheClient;
  /** Host HTTP client for fixed operator hosts. */
  http: HttpClient;
  /** Credits for the client's source; stations carry them when given. */
  contributors?: readonly Attribution[];
}

/**
 * Interface for regional car-sharing operator clients.
 * Each client handles fetching and mapping from one operator's API.
 */
export interface RegionalCarSharingClient {
  /**
   * Unique identifier for this client (e.g., "de-cambio", "de-stadtteilauto"). It is also
   * the manifest `dataSources` entry its stations are credited under.
   */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Geographic regions this client covers (used for bbox pre-filtering). */
  readonly regions: { center: LngLat; radiusKm: number }[];
  /** Search for stations within the bounding box. */
  search(bbox: BoundingBox, context: RegionalSearchContext): Promise<SharedMobilityStation[]>;
}

const KM_PER_DEGREE_LATITUDE = 111;

/**
 * Check if a bbox can hold a point within `radiusKm` of the region's center: the
 * bbox, padded by the radius, contains the center. A degree of longitude spans
 * cos(latitude) × 111 km, so the longitude padding widens with latitude.
 */
export function regionMatchesBbox(
  region: { center: LngLat; radiusKm: number },
  bbox: BoundingBox,
): boolean {
  const [lng, lat] = region.center;
  const latPad = region.radiusKm / KM_PER_DEGREE_LATITUDE;
  const lngPad = latPad / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return (
    lat >= bbox.south - latPad &&
    lat <= bbox.north + latPad &&
    lng >= bbox.west - lngPad &&
    lng <= bbox.east + lngPad
  );
}

/** Check if a bbox overlaps with any of the client's regions. */
export function clientMatchesBbox(client: RegionalCarSharingClient, bbox: BoundingBox): boolean {
  return client.regions.some((region) => regionMatchesBbox(region, bbox));
}
