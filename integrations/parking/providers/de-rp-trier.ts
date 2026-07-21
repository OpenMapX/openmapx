import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeRpTrierPayload, mergeDeRpTrierLive } from "./de-rp-trier-mapper.js";

/**
 * Reuse note (Stadtwerke Trier / SWT): the XML feed at service.swt.de is
 * publicly accessible without an explicit licence, and the operator's
 * impressum reserves all rights to the website's contents. We surface the
 * realtime counts on the assumption that factual occupancy data falls outside
 * copyright protection. Operators republishing OpenMapX should contact SWT
 * for a formal licence.
 */

const STATION_ID_PREFIX = "de-rp-trier:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-rp-trier",
  mapStatic: mapDeRpTrierPayload,
  mergeWithLive: mergeDeRpTrierLive,
  coverage: [6.6, 49.72, 6.7, 49.78],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeRpTrier(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeRpTrierDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
