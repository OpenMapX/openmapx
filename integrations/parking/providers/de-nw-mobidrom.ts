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
 * (poi_ingest.de_nw_mobidrom_static + Redis hash `poi:live:de-nw-mobidrom`);
 * this file just bridges the parking provider chain to the shared two-tier reader.
 */

const STATION_ID_PREFIX = "de-nw-mobidrom:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-nw-mobidrom",
  mapStatic: makeMobidromMapper({
    sourceId: "de-nw-mobidrom",
    idPrefix: "nrw",
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.87, 50.32, 9.46, 52.53],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeNwMobidrom(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeNwMobidromDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
