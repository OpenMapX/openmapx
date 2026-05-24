import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapCitaLuPayload, mergeCitaLuLive } from "./cita-lu-mapper.js";

/**
 * CITA Luxembourg DATEX II parking thin wrapper.
 *
 * Static records + per-record `vacantSpaces` now flow through the POI ingest
 * pipeline (`poi_ingest.cita_lu_static` + Redis hash `poi:live:cita-lu`).
 */

const STATION_ID_PREFIX = "cita-lu:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "cita-lu",
  mapStatic: mapCitaLuPayload,
  mergeWithLive: mergeCitaLuLive,
  coverage: [5.7, 49.4, 6.6, 50.2],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchCitaLu(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchCitaLuDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
