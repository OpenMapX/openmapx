import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeParkapiV2Payload, mergeDeParkapiV2Live } from "./de-parkapi-v2-mapper.js";

/**
 * ParkAPI v2 (ParkenDD) thin wrapper.
 *
 * The federated city catalog + per-city-lot fan-out lives entirely in the
 * bundled parser (see parkapi-v2-bundled-parser.ts for the WHY); this module
 * just bridges the parking provider chain to the shared two-tier reader.
 */

// Broad EU bbox — ParkenDD covers DE/AT/CH and several neighbours. The per-city
// fan-out already prunes records to active cities, so the coverage check here
// is purely a perf short-circuit for queries far outside Europe.
const reader = createTwoTierPoiReader<ParkingFacility>({
  sourceId: "de-parkapi-v2",
  mapStatic: mapDeParkapiV2Payload,
  mergeWithLive: mergeDeParkapiV2Live,
  coverage: [-5, 35, 30, 60],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeParkapiV2(bbox: BoundingBox): Promise<ParkingFacility[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeParkapiV2Detail(
  cityName: string,
  lotId: string,
): Promise<ParkingFacility | null> {
  return reader.fetchDetail(getRuntimeContext(), `${cityName}/${lotId}`);
}
