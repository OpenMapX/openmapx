import { fetchJson, type PlacePhoto } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "@openmapx/integration-framework";

/** A geographic bounding box in [west, south, east, north] degrees. */
export interface PhotoBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface BboxPhotoProviderConfig<T> {
  readonly id: string;
  readonly name: string;
  /** Half-extent of the bbox in degrees around the query point. Defaults to 0.003 (~330m). */
  readonly deltaDeg?: number;
  /** Build the provider request URL from the computed bbox and the query. */
  buildUrl(bbox: PhotoBbox, query: PhotoQuery): string;
  /** Map the fetched JSON response into PlacePhotos. */
  parse(data: T, query: PhotoQuery): PlacePhoto[];
}

/**
 * Factory for bbox-based photo providers (Mapillary, Panoramax) that share an
 * identical skeleton: compute a small bbox around the query point, fetch JSON,
 * and map the response into PlacePhotos. Per-provider behavior is supplied via
 * `buildUrl` and `parse`.
 *
 * Preserves the exact fetch semantics both providers use: 5000ms timeout, no
 * User-Agent header, and `[]` on fetch failure or empty results.
 */
export function createBboxPhotoProvider<T>(config: BboxPhotoProviderConfig<T>): PhotoProvider {
  const { id, name, deltaDeg = 0.003, buildUrl, parse } = config;

  return {
    id,
    name,

    async search(query: PhotoQuery): Promise<PlacePhoto[]> {
      const bbox: PhotoBbox = {
        west: query.lng - deltaDeg,
        south: query.lat - deltaDeg,
        east: query.lng + deltaDeg,
        north: query.lat + deltaDeg,
      };

      const url = buildUrl(bbox, query);

      const data = await fetchJson<T>(url, {
        timeoutMs: 5000,
        userAgent: null,
        nullOnError: true,
      });
      if (!data) return [];

      return parse(data, query);
    },
  };
}
