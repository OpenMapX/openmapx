import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDuesseldorfPayload, mergeDuesseldorfLive } from "./duesseldorf-de-mapper.js";

const STATION_ID_PREFIX = "duesseldorf:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "duesseldorf-de",
  mapStatic: mapDuesseldorfPayload,
  mergeWithLive: mergeDuesseldorfLive,
  coverage: [6.65, 51.12, 6.95, 51.35],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDuesseldorfDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDuesseldorfDeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
