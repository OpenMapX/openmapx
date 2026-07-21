import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeBbPotsdamPayload, mergeDeBbPotsdamLive } from "./de-bb-potsdam-mapper.js";

/**
 * Reuse note (Stadtwerke Potsdam / SWP): the CSV feed is publicly reachable on
 * an Azure-hosted endpoint without an explicit licence, and SWP's impressum
 * states that all rights to swp-potsdam.de content remain with Stadtwerke
 * Potsdam GmbH. We surface the data on the assumption that factual occupancy
 * counts fall outside copyright protection. Operators republishing OpenMapX
 * should contact SWP for a formal licence.
 */

const STATION_ID_PREFIX = "de-bb-potsdam:";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-bb-potsdam",
  mapStatic: mapDeBbPotsdamPayload,
  mergeWithLive: mergeDeBbPotsdamLive,
  coverage: [12.85, 52.32, 13.2, 52.5],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeBbPotsdam(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeBbPotsdamDetail(id: string): Promise<ParkingFacility | null> {
  const poiId = id.startsWith(STATION_ID_PREFIX) ? id.slice(STATION_ID_PREFIX.length) : id;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
