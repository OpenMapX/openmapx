/**
 * Registry for regional car-sharing operator clients.
 * The car-sharing provider queries all registered clients whose regions overlap the bbox.
 */

import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { clientMatchesBbox, type RegionalCarSharingClient } from "./regional-client-types.js";

const clients: RegionalCarSharingClient[] = [];

let log: Logger | null = null;

export function setCarSharingLogger(logger: Logger): void {
  log = logger;
}

export function registerCarSharingClient(client: RegionalCarSharingClient): void {
  clients.push(client);
}

export function getRegisteredClients(): readonly RegionalCarSharingClient[] {
  return clients;
}

/**
 * Search all registered regional clients whose regions overlap the bbox.
 * Returns stations from all matching clients.
 */
export async function searchRegionalClients(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
  const matching = clients.filter((c) => clientMatchesBbox(c, bbox));
  if (matching.length === 0) return [];

  const results = await Promise.allSettled(matching.map((c) => c.search(bbox)));

  const stations: SharedMobilityStation[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      stations.push(...r.value);
    } else {
      log?.warn(`car-sharing source ${matching[i].id} failed`, r.reason);
    }
  }
  if (matching.length > 0 && results.every((r) => r.status === "rejected")) {
    log?.error("all car-sharing sources failed");
  }
  return stations;
}
