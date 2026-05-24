import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapFlorencePayload, mergeFlorenceLive } from "./florence-it-mapper.js";

/**
 * Comune di Firenze ParkFreeSpot thin wrapper.
 *
 * Bundled static + per-record `freeSpaces` flow through the POI ingest
 * pipeline (`poi_ingest.florence_it_static` + Redis hash `poi:live:florence-it`).
 */

const STATION_ID_PREFIX = "florence:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "florence-it",
  mapStatic: mapFlorencePayload,
  mergeWithLive: mergeFlorenceLive,
  coverage: [11.18, 43.72, 11.32, 43.82],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchFlorenceIt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchFlorenceItDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
