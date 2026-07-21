import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapFrBnlsPayload } from "./fr-bnls-mapper.js";

/**
 * BNLS France (Opendatasoft mirror) thin wrapper.
 *
 * Static-only GeoJSON ingest runs in data-manager; this file bridges the
 * parking provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "fr-bnls:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "fr-bnls",
  mapStatic: mapFrBnlsPayload,
  coverage: [-5.2, 41.3, 9.6, 51.1],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchFrBnls(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchFrBnlsDetail(bnlsId: string): Promise<ParkingFacility | null> {
  const poiId = bnlsId.startsWith(STATION_ID_PREFIX)
    ? bnlsId.slice(STATION_ID_PREFIX.length)
    : bnlsId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
