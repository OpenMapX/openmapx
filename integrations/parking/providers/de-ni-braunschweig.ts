import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import {
  mapDeNiBraunschweigPayload,
  mergeDeNiBraunschweigLive,
} from "./de-ni-braunschweig-mapper.js";

const STATION_ID_PREFIX = "de-ni-braunschweig:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-ni-braunschweig",
  mapStatic: mapDeNiBraunschweigPayload,
  mergeWithLive: mergeDeNiBraunschweigLive,
  coverage: [10.4, 52.18, 10.65, 52.36],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeNiBraunschweig(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeNiBraunschweigDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
