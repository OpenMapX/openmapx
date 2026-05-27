import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapBremenPayload } from "./bremen-de-mapper.js";

const STATION_ID_PREFIX = "bremen:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "bremen-de",
  mapStatic: mapBremenPayload,
  coverage: [8.45, 53.0, 8.95, 53.25],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBremenDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBremenDeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
