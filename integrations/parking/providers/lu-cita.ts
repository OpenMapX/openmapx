import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapLuCitaPayload, mergeLuCitaLive } from "./lu-cita-mapper.js";

/**
 * CITA Luxembourg DATEX II parking thin wrapper.
 *
 * Static records + per-record `vacantSpaces` now flow through the POI ingest
 * pipeline (`poi_ingest.lu_cita_static` + Redis hash `poi:live:lu-cita`).
 */

const STATION_ID_PREFIX = "lu-cita:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "lu-cita",
  mapStatic: mapLuCitaPayload,
  mergeWithLive: mergeLuCitaLive,
  coverage: [5.7, 49.4, 6.6, 50.2],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchLuCita(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchLuCitaDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
