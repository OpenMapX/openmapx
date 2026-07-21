import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapBeBruBrusselsPayload } from "./be-bru-brussels-mapper.js";

/**
 * Brussels OpenDataSoft v2.1 catalog thin wrapper.
 *
 * Static-only ingest now runs in data-manager; this file bridges the parking
 * provider chain to the shared static reader so apps/api keeps returning
 * ParkingFacility objects via the same interface as before.
 */

const STATION_ID_PREFIX = "be-bru-brussels:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "be-bru-brussels",
  mapStatic: mapBeBruBrusselsPayload,
  coverage: [4.25, 50.78, 4.48, 50.92],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBeBruBrussels(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBeBruBrusselsDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
