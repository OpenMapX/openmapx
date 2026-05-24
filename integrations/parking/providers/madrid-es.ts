import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapMadridPayload } from "./madrid-es-mapper.js";

/**
 * Madrid (Ayuntamiento de Madrid) JSON-LD parking catalog thin wrapper.
 *
 * Static-only ingest now runs in data-manager; this file bridges the parking
 * provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "madrid:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "madrid-es",
  mapStatic: mapMadridPayload,
  coverage: [-3.9, 40.3, -3.5, 40.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchMadridEs(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchMadridEsDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
