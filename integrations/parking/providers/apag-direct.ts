import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * Direct APAG (Aachener Parkhaus GmbH) operator feed thin wrapper.
 *
 * Reads from the `apag-direct` ingest source, which fans out from apag.de's
 * own PMS API. The Mobidrom-shaped payload (see apag-direct-parser.ts) lets
 * us reuse the Mobidrom mapper + live merger verbatim.
 */

const STATION_ID_PREFIX = "apag-direct:";
const OPERATOR_NAME = "APAG - Aachener Parkhaus GmbH";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "apag-direct",
  mapStatic: makeMobidromMapper({
    sourceId: "apag-direct",
    idPrefix: "apag-direct",
    operatorName: OPERATOR_NAME,
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.9, 50.65, 6.3, 50.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchApagDirect(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchApagDirectDetail(externalId: string): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
