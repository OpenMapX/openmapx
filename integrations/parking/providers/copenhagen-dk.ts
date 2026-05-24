import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapCopenhagenPayload } from "./copenhagen-dk-mapper.js";

/**
 * Københavns Kommune p_hus thin wrapper.
 *
 * Static-only WFS ingest runs in data-manager; this file bridges the parking
 * provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "copenhagen:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "copenhagen-dk",
  mapStatic: mapCopenhagenPayload,
  coverage: [12.45, 55.6, 12.68, 55.75],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchCopenhagenDk(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchCopenhagenDkDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
