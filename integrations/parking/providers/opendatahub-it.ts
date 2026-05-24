import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapOdhItPayload, mergeOdhItLive } from "./opendatahub-it-mapper.js";

/**
 * Open Data Hub South Tyrol parking thin wrapper.
 *
 * Bundled stations + per-station latest measurements flow through the POI
 * ingest pipeline (`poi_ingest.opendatahub_it_static` + Redis hash
 * `poi:live:opendatahub-it`).
 */

const STATION_ID_PREFIX = "odh:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "opendatahub-it",
  mapStatic: mapOdhItPayload,
  mergeWithLive: mergeOdhItLive,
  coverage: [10.3, 46.2, 12.5, 47.1],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchOdhIt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchOdhItDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
