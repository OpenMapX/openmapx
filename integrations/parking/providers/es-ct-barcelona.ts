import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapEsCtBarcelonaPayload } from "./es-ct-barcelona-mapper.js";

/**
 * Ajuntament de Barcelona parking-locations thin wrapper.
 *
 * Static-only JSON ingest runs in data-manager; this file bridges the parking
 * provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "es-ct-barcelona:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "es-ct-barcelona",
  mapStatic: mapEsCtBarcelonaPayload,
  coverage: [2.05, 41.32, 2.23, 41.47],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchEsCtBarcelona(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchEsCtBarcelonaDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
