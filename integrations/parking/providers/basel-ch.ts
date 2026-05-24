import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapBaselPayload, mergeBaselLive } from "./basel-ch-mapper.js";

/**
 * Basel-Stadt parking garages thin wrapper.
 *
 * Static metadata + per-garage live `freeSpaces` now flow through the POI
 * ingest pipeline (`poi_ingest.basel_ch_static` + Redis hash `poi:live:basel-ch`).
 */

const STATION_ID_PREFIX = "basel:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "basel-ch",
  mapStatic: mapBaselPayload,
  mergeWithLive: mergeBaselLive,
  coverage: [7.55, 47.52, 7.65, 47.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBaselCh(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBaselChDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
