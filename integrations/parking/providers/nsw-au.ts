import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapNswAuPayload, mergeNswAuLive } from "./nsw-au-mapper.js";

/**
 * Transport for NSW Car Park thin wrapper.
 *
 * Bundled static + per-facility live (spots/total) flows through the POI
 * ingest pipeline (`poi_ingest.nsw_au_static` + Redis hash `poi:live:nsw-au`).
 */

const STATION_ID_PREFIX = "nsw:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "nsw-au",
  mapStatic: mapNswAuPayload,
  mergeWithLive: mergeNswAuLive,
  coverage: [150.6, -34.8, 151.4, -33.4],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNswAu(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNswAuDetail(facilityId: string): Promise<ParkingFacility | null> {
  const poiId = facilityId.startsWith(STATION_ID_PREFIX)
    ? facilityId.slice(STATION_ID_PREFIX.length)
    : facilityId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
