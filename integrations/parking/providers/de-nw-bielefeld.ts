import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeNwBielefeldPayload, mergeDeNwBielefeldLive } from "./de-nw-bielefeld-mapper.js";

const STATION_ID_PREFIX = "de-nw-bielefeld:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-nw-bielefeld",
  mapStatic: mapDeNwBielefeldPayload,
  mergeWithLive: mergeDeNwBielefeldLive,
  coverage: [8.4, 51.9, 8.7, 52.13],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeNwBielefeld(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeNwBielefeldDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
