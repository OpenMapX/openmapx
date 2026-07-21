import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeAutobahnPayload } from "./de-autobahn-mapper.js";

/**
 * Autobahn GmbH rest area / truck parking thin wrapper.
 *
 * Bundled-but-static-only: the parser fans out across all Autobahn road IDs
 * to gather every parking_lorry entry once per ingest run; no live tier
 * because the upstream doesn't expose realtime occupancy. Static rows live
 * in `poi_ingest.autobahn_de_static`.
 */

const STATION_ID_PREFIX = "de-autobahn:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "de-autobahn",
  mapStatic: mapDeAutobahnPayload,
  coverage: [5.8, 47.2, 15.1, 55.1],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeAutobahn(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeAutobahnDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
