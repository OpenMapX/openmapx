import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapSgHdbPayload, mergeSgHdbLive } from "./sg-hdb-mapper.js";

/**
 * Singapore HDB carpark thin wrapper.
 *
 * Static catalog (SVY21 → WGS84 converted) + live carpark-availability flow
 * through the POI ingest pipeline via two separate specs (different cadences):
 *   - static: daily (gov.sg datastore)
 *   - live:   per-minute snapshot (data.gov.sg carpark-availability)
 * The live state carries authoritative car-lot capacity + freeSpaces so the
 * mapper merges them onto the static base.
 */

const STATION_ID_PREFIX = "sg-hdb:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "sg-hdb",
  mapStatic: mapSgHdbPayload,
  mergeWithLive: mergeSgHdbLive,
  coverage: [103.6, 1.2, 104.05, 1.48],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchSgHdb(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchSgHdbDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
