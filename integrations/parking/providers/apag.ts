import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * APAG (Aachener Parkhaus GmbH) operator feed thin wrapper.
 *
 * Richer than the APAG subset of the aggregate `parken-nrw` feed because
 * this operator endpoint reports live `availableSpaces` for every site.
 */

const STATION_ID_PREFIX = "apag:";
const OPERATOR_NAME = "APAG - Aachener Parkhaus GmbH";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "apag",
  mapStatic: makeMobidromMapper({
    sourceId: "apag",
    idPrefix: "apag",
    operatorName: OPERATOR_NAME,
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.9, 50.65, 6.3, 50.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchApag(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchApagDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
