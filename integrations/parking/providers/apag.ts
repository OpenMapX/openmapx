import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { makeMobidromMapper, mergeMobidromLive } from "./mobidrom-mapper.js";

/**
 * APAG (Aachener Parkhaus GmbH) operator feed thin wrapper, reading the
 * apag.de PMS API directly. The companion `apag-mobidrom` reader is kept as
 * a backup data lineage going through the NRW Mobilithek exporter. The
 * Mobidrom-shaped payload (see apag-parser.ts) lets us reuse the Mobidrom
 * mapper + live merger verbatim.
 *
 * Reuse note: the direct apag.de feed publishes no reuse licence, but the same
 * dataset is also published under Datenlizenz Deutschland Namensnennung 2.0
 * via NRW.Mobidrom; that openly-licensed copy ships as the separate
 * `apag-mobidrom` source.
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
