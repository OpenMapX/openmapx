import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * APAG (Aachener Parkhaus GmbH) operator feed via the NRW Mobilithek exporter
 * (mobilitaetsdaten.nrw). Kept alongside the primary `de-apag` reader (which
 * fetches apag.de directly) so the data lineage through the open-data
 * intermediary stays available; when the Mobilithek exporter is broken
 * upstream the primary reader continues to surface live data.
 */

const STATION_ID_PREFIX = "de-apag-mobidrom:";
const OPERATOR_NAME = "APAG - Aachener Parkhaus GmbH";

const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-apag-mobidrom",
  mapStatic: makeMobidromMapper({
    sourceId: "de-apag-mobidrom",
    idPrefix: "de-apag-mobidrom",
    operatorName: OPERATOR_NAME,
  }),
  mergeWithLive: mergeMobidromLive,
  coverage: [5.9, 50.65, 6.3, 50.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeApagMobidrom(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeApagMobidromDetail(
  externalId: string,
): Promise<ParkingFacility | null> {
  const poiId = externalId.startsWith(STATION_ID_PREFIX)
    ? externalId.slice(STATION_ID_PREFIX.length)
    : externalId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}
