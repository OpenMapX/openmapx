import { snapshotContributors } from "@openmapx/mobility-core/contributors";
/**
 * Factory for creating RegionalCarSharingClient from static data URLs.
 * Handles fetch, caching, and bbox filtering. Caller provides the parser.
 */

import { bboxContains, type LngLat, USER_AGENT } from "@openmapx/core";
import { captureCacheWriter } from "@openmapx/integration-framework";
import { cacheGet, TTL } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { RegionalCarSharingClient, RegionalSearchContext } from "./regional-client-types.js";

const FETCH_TIMEOUT_MS = 10_000;
/** Each feed lists one region's stations; the largest is about 110 KB. */
const MAX_STATION_FEED_BYTES = 2 * 1024 * 1024;

export interface StaticCarSharingConfig {
  /** Unique client ID, also the manifest `dataSources` entry its stations are credited under. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** URL to fetch station data from. */
  url: string;
  /** Media types the feed may declare. */
  contentTypes: readonly string[];
  /** Geographic regions this client covers. */
  regions: { center: LngLat; radiusKm: number }[];
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
  const cacheKey = `cache:carsharing:static:contributors-v1:${config.id}`;

  async function fetchData({
    cache,
    http,
    contributors,
  }: RegionalSearchContext): Promise<SharedMobilityStation[]> {
    const cached = await cacheGet<SharedMobilityStation[]>(cache, cacheKey);
    if (cached) return cached;

    const writer = await captureCacheWriter(cache);
    try {
      const res = await http.getText(config.url, {
        maxBytes: MAX_STATION_FEED_BYTES,
        contentTypes: config.contentTypes,
        discardErrorBody: true,
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (res.status !== 200) return [];

      const stations = config
        .parse(res.body)
        .map((station) =>
          contributors === undefined
            ? station
            : { ...station, contributors: snapshotContributors(contributors) },
        );

      await writer.set(cacheKey, stations, TTL.sharedMobility.stations);
      return stations;
    } catch {
      return [];
    }
  }

  return {
    id: config.id,
    name: config.name,
    regions: config.regions,
    async search(bbox, context) {
      const all = await fetchData(context);
      return all.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
    },
  };
}
