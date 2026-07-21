import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * APCOA Deutschland operator feed thin wrapper. No geographic coverage gate —
 * APCOA operates across Europe and the feed is currently small (often empty)
 * so an early-return short-circuit isn't worth the maintenance.
 */

const STATION_ID_PREFIX = "de-apcoa:";
const OPERATOR_NAME = "APCOA Deutschland GmbH";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-apcoa",
  mapStatic: makeMobidromMapper({
    sourceId: "de-apcoa",
    idPrefix: "de-apcoa",
    operatorName: OPERATOR_NAME,
  }),
  mergeWithLive: mergeMobidromLive,
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeApcoa(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeApcoaDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
