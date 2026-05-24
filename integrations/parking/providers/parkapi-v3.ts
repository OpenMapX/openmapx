import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapParkApiV3Payload, mergeParkApiV3Live } from "./parkapi-v3-mapper.js";

/**
 * ParkAPI v3 (MobiData BW) thin wrapper.
 *
 * The bundled parser running in data-manager produces both the static rows and
 * the per-poi live state every 5 minutes; this module just bridges the parking
 * provider chain to the shared two-tier reader.
 */

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "parkapi-v3",
  mapStatic: mapParkApiV3Payload,
  mergeWithLive: mergeParkApiV3Live,
  coverage: [5.5, 45.5, 15.5, 55.5],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchParkApiV3(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchParkApiV3Detail(siteId: number): Promise<ParkingFacility | null> {
  return reader.fetchDetail(getRuntimeContext(), String(siteId));
}
