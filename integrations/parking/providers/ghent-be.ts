import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapGhentPayload, mergeGhentLive } from "./ghent-be-mapper.js";

/**
 * Stad Gent real-time garages thin wrapper.
 *
 * Bundled static + per-garage live state flow through the POI ingest pipeline
 * (`poi_ingest.ghent_be_static` + Redis hash `poi:live:ghent-be`).
 */

const STATION_ID_PREFIX = "ghent:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "ghent-be",
  mapStatic: mapGhentPayload,
  mergeWithLive: mergeGhentLive,
  coverage: [3.6, 50.95, 3.85, 51.15],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchGhentBe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchGhentBeDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
