import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapTrierPayload, mergeTrierLive } from "./trier-de-mapper.js";

const STATION_ID_PREFIX = "trier:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "trier-de",
  mapStatic: mapTrierPayload,
  mergeWithLive: mergeTrierLive,
  coverage: [6.6, 49.72, 6.7, 49.78],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchTrierDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchTrierDeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
