import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapBielefeldPayload, mergeBielefeldLive } from "./bielefeld-de-mapper.js";

const STATION_ID_PREFIX = "bielefeld:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "bielefeld-de",
  mapStatic: mapBielefeldPayload,
  mergeWithLive: mergeBielefeldLive,
  coverage: [8.4, 51.9, 8.7, 52.13],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBielefeldDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBielefeldDeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
