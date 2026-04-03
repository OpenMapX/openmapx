/**
 * Registry for regional car-sharing operator clients.
 * The car-sharing provider queries all registered clients whose regions overlap the bbox.
 */

import type { BoundingBox } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/integration-shared-mobility/types";
import { clientMatchesBbox, type RegionalCarSharingClient } from "./regional-client-types.js";

const clients: RegionalCarSharingClient[] = [];

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
  for (const r of results) {
    if (r.status === "fulfilled") stations.push(...r.value);
  }
  return stations;
}
