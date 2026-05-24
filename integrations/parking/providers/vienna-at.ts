import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapViennaPayload } from "./vienna-at-mapper.js";

/**
 * Stadt Wien GARAGENOGD thin wrapper.
 *
 * Static-only WFS ingest runs in data-manager; this file bridges the parking
 * provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "vienna:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "vienna-at",
  mapStatic: mapViennaPayload,
  coverage: [16.18, 48.1, 16.58, 48.33],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchViennaAt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchViennaAtDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
