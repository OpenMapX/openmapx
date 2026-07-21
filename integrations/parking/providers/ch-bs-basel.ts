import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapChBsBaselPayload, mergeChBsBaselLive } from "./ch-bs-basel-mapper.js";

/**
 * Basel-Stadt parking garages thin wrapper.
 *
 * Static metadata + per-garage live `freeSpaces` now flow through the POI
 * ingest pipeline (`poi_ingest.ch_bs_basel_static` + Redis hash `poi:live:ch-bs-basel`).
 */

const STATION_ID_PREFIX = "ch-bs-basel:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "ch-bs-basel",
  mapStatic: mapChBsBaselPayload,
  mergeWithLive: mergeChBsBaselLive,
  coverage: [7.55, 47.52, 7.65, 47.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchChBsBasel(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchChBsBaselDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
