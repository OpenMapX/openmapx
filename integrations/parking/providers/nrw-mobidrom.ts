import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * NRW Mobidrom aggregate parking feed thin wrapper.
 *
 * Static + per-poi live state now live in the POI ingest pipeline
 * (poi_ingest.nrw_mobidrom_parking_static + Redis hash `poi:live:nrw-mobidrom-parking`);
 * this file just bridges the parking provider chain to the shared two-tier reader.
 */

const STATION_ID_PREFIX = "nrw:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "nrw-mobidrom-parking",
  mapStatic: makeMobidromMapper({
    sourceId: "nrw-mobidrom-parking",
    idPrefix: "nrw",
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.87, 50.32, 9.46, 52.53],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNrwMobidrom(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNrwMobidromDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
