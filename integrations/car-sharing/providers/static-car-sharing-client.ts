/**
 * Factory for creating RegionalCarSharingClient from static data URLs.
 * Handles fetch, caching, and bbox filtering. Caller provides the parser.
 */

import { type BoundingBox, bboxContains, type LngLat, USER_AGENT } from "@openmapx/core";
import { type CacheClient, cacheGet, cacheSet, TTL } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { RegionalCarSharingClient } from "./regional-client-types.js";

const FETCH_TIMEOUT_MS = 10_000;
const HEADERS = { "User-Agent": USER_AGENT };

export interface StaticCarSharingConfig {
  /** Unique client ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** URL to fetch station data from. */
  url: string;
  /** Geographic regions this client covers. */
  regions: { center: LngLat; radiusKm: number }[];
  /** Attribution for the data. */
  attribution: {
    label: string;
    url: string;
    license?: string;
    licenseUrl?: string;
  };
  /** Parse raw response body into stations. Only stations with valid coordinates should be returned. */
  parse(body: string): SharedMobilityStation[];
}

/**
 * Create a RegionalCarSharingClient from a static data config.
 * Fetches the URL once, caches in Redis, and filters by bbox on each search.
 */
export function createStaticCarSharingClient(
  config: StaticCarSharingConfig,
): RegionalCarSharingClient {
  const cacheKey = `cache:carsharing:static:${config.id}`;

  async function fetchData(cache: CacheClient): Promise<SharedMobilityStation[]> {
    const cached = await cacheGet<SharedMobilityStation[]>(cache, cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(config.url, { headers: HEADERS, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];

      const body = await res.text();
      const stations = config.parse(body);

      await cacheSet(cache, cacheKey, stations, TTL.sharedMobility.stations);
      return stations;
    } catch {
      clearTimeout(timer);
      return [];
    }
  }

  return {
    id: config.id,
    name: config.name,
    regions: config.regions,
    attribution: config.attribution,
    async search(bbox: BoundingBox, cache: CacheClient): Promise<SharedMobilityStation[]> {
      const all = await fetchData(cache);
      return all.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
    },
  };
}
