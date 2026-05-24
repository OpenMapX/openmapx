import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * NRW Mobidrom Park+Ride aggregate thin wrapper.
 *
 * Every record in this feed is authoritatively a P+R facility — the bundled
 * parser sets `parkAndRide: true` via `forceParkAndRide` regardless of name
 * heuristics.
 */

const STATION_ID_PREFIX = "nrw-pr:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "nrw-mobidrom-pr",
  mapStatic: makeMobidromMapper({
    sourceId: "nrw-mobidrom-pr",
    idPrefix: "nrw-pr",
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.87, 50.32, 9.46, 52.53],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNrwPr(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNrwPrDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
