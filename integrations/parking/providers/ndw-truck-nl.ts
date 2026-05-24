import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapNdwTruckNlPayload, mergeNdwTruckNlLive } from "./ndw-truck-nl-mapper.js";

/**
 * NDW Netherlands truck parking thin wrapper.
 *
 * Bundled DATEX II static table + per-record live vacancies flow through the
 * POI ingest pipeline (`poi_ingest.ndw_truck_nl_static` + Redis hash
 * `poi:live:ndw-truck-nl`).
 */

const STATION_ID_PREFIX = "ndw-truck:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "ndw-truck-nl",
  mapStatic: mapNdwTruckNlPayload,
  mergeWithLive: mergeNdwTruckNlLive,
  coverage: [3.3, 50.7, 7.3, 53.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNdwTruckNl(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNdwTruckNlDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
