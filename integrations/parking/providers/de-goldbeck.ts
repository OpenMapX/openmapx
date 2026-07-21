import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * GOLDBECK Parking Services operator feed thin wrapper. No coverage gate —
 * the operator is mostly NRW-resident but not formally constrained, and the
 * dataset is small enough that a Germany-wide DB roundtrip is acceptable.
 */

const STATION_ID_PREFIX = "de-goldbeck:";
const OPERATOR_NAME = "GOLDBECK Parking Services GmbH";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-goldbeck",
  mapStatic: makeMobidromMapper({
    sourceId: "de-goldbeck",
    idPrefix: "de-goldbeck",
    operatorName: OPERATOR_NAME,
  }),
  mergeWithLive: mergeMobidromLive,
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeGoldbeck(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeGoldbeckDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
