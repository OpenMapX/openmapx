import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapBambergPayload, mergeBambergLive } from "./bamberg-de-mapper.js";

/**
 * Reuse note (Stadtwerke Bamberg): the operator publishes no reuse licence,
 * and its impressum states that publication on the internet does not imply
 * consent for reuse. We surface the data on the assumption that factual
 * occupancy counts fall outside copyright protection. Operators republishing
 * OpenMapX should contact Stadtwerke Bamberg for a formal licence.
 */

const STATION_ID_PREFIX = "bamberg:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "bamberg-de",
  mapStatic: mapBambergPayload,
  mergeWithLive: mergeBambergLive,
  coverage: [10.83, 49.85, 10.94, 49.94],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBambergDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBambergDeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
