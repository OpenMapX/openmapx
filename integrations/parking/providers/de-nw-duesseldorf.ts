import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeNwDuesseldorfPayload, mergeDeNwDuesseldorfLive } from "./de-nw-duesseldorf-mapper.js";

const STATION_ID_PREFIX = "de-nw-duesseldorf:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-nw-duesseldorf",
  mapStatic: mapDeNwDuesseldorfPayload,
  mergeWithLive: mergeDeNwDuesseldorfLive,
  coverage: [6.65, 51.12, 6.95, 51.35],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeNwDuesseldorf(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeNwDuesseldorfDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
