import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapUtmcPayload, mergeUtmcLive } from "./utmc-newcastle-mapper.js";

/**
 * UTMC (Urban Traffic Management and Control) Tyne & Wear thin wrapper.
 *
 * The static + live ingest now runs in data-manager via the POI source
 * registry; this file just bridges the parking provider chain to the
 * shared two-tier reader so the API can return ParkingFacility objects
 * built from poi_ingest.utmc_newcastle_static + the Redis live hash.
 */

const STATION_ID_PREFIX = "utmc:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "utmc-newcastle",
  mapStatic: mapUtmcPayload,
  mergeWithLive: mergeUtmcLive,
  coverage: [-1.8, 54.85, -1.4, 55.1],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchUtmcNewcastle(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchUtmcNewcastleDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
