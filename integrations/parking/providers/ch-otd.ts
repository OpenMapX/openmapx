import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapChOtdPayload, mergeChOtdLive } from "./ch-otd-mapper.js";

/**
 * OpenTransportData.swiss bike-and-car-parking thin wrapper.
 *
 * Static catalog + derived `freeSpaces` (from
 * `currentEstimatedOccupancy × capacity`) flow through the POI ingest
 * pipeline (`poi_ingest.opentransportdata_ch_parking_static` + Redis hash
 * `poi:live:opentransportdata-ch-parking`).
 */

const STATION_ID_PREFIX = "ch-otd:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "ch-otd",
  mapStatic: mapChOtdPayload,
  mergeWithLive: mergeChOtdLive,
  coverage: [5.96, 45.82, 10.49, 47.81],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchChOtd(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchChOtdDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
