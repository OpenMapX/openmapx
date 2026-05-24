import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDbBahnParkPayload } from "./db-bahnpark-mapper.js";

/**
 * DB BahnPark Parking Information API thin wrapper.
 *
 * Static ingest (no live occupancy) runs in data-manager via the POI source
 * registry; this file bridges the parking provider chain to the shared
 * static reader so the API can return ParkingFacility objects built from
 * `poi_ingest.db_bahnpark_static`.
 */

const STATION_ID_PREFIX = "db-bahnpark:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "db-bahnpark",
  mapStatic: mapDbBahnParkPayload,
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDbBahnPark(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDbBahnParkDetail(facilityId: string): Promise<ParkingFacility | null> {
  const poiId = facilityId.startsWith(STATION_ID_PREFIX)
    ? facilityId.slice(STATION_ID_PREFIX.length)
    : facilityId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
