/**
 * Registry for regional car-sharing operator clients.
 * The car-sharing provider queries all registered clients whose regions overlap the bbox.
 */

import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import type { CacheClient } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { clientMatchesBbox, type RegionalCarSharingClient } from "./regional-client-types.js";

export function createRegionalCarSharingRegistry(options: {
  clients: readonly RegionalCarSharingClient[];
  cache: CacheClient;
  log: Logger;
}): (bbox: BoundingBox) => Promise<SharedMobilityStation[]> {
  return async (bbox) => {
    const matching = options.clients.filter((client) => clientMatchesBbox(client, bbox));
    if (matching.length === 0) return [];
    const results = await Promise.allSettled(
      matching.map((client) => client.search(bbox, options.cache)),
    );
    const stations: SharedMobilityStation[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === "fulfilled") {
        stations.push(...result.value);
      } else {
        options.log.warn(`car-sharing source ${matching[index]?.id} failed`, result.reason);
      }
    }
    if (results.every((result) => result.status === "rejected")) {
      options.log.error("all car-sharing sources failed");
    }
    return stations;
  };
}
