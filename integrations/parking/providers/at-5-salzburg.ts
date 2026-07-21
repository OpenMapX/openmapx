import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapAt5SalzburgPayload, mergeAt5SalzburgLive } from "./at-5-salzburg-mapper.js";

const STATION_ID_PREFIX = "at-5-salzburg:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "at-5-salzburg",
  mapStatic: mapAt5SalzburgPayload,
  mergeWithLive: mergeAt5SalzburgLive,
  coverage: [12.95, 47.72, 13.13, 47.88],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchAt5Salzburg(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchAt5SalzburgDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
