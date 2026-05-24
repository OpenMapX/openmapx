import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapRdwNlPayload } from "./rdw-nl-mapper.js";

/**
 * RDW Netherlands Open Data thin wrapper.
 *
 * Federated static ingest (specs + 3 GEO datasets, joined inside the parser)
 * runs in data-manager via the POI source registry; this file bridges the
 * parking provider chain to the shared static reader.
 */

const STATION_ID_PREFIX = "rdw:";

const reader = createStaticPoiReader<ParkingFacility>({
  sourceId: "rdw-nl",
  mapStatic: mapRdwNlPayload,
  coverage: [3.3, 50.7, 7.3, 53.7],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchRdwNl(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchRdwNlDetail(
  areamanagerid: string,
  areaid: string,
): Promise<ParkingFacility | null> {
  if (!/^[\w-]+$/.test(areamanagerid) || !/^[\w.-]+$/.test(areaid)) return null;
  return reader.fetchDetail(getRuntimeContext(), `${areamanagerid}/${areaid}`);
}
