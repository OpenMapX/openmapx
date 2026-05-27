import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapSalzburgPayload, mergeSalzburgLive } from "./salzburg-at-mapper.js";

const STATION_ID_PREFIX = "salzburg:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "salzburg-at",
  mapStatic: mapSalzburgPayload,
  mergeWithLive: mergeSalzburgLive,
  coverage: [12.95, 47.72, 13.13, 47.88],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchSalzburgAt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchSalzburgAtDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
