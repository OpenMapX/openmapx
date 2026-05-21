import type { BoundingBox } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";

export interface FuelPriceProvider {
  readonly name: string;
  /** Returns true if this provider covers the given bounding box. */
  supports(bbox: BoundingBox): boolean;
  /** Fetches fuel stations with prices within the bounding box. */
  searchStations(bbox: BoundingBox): Promise<FuelStation[]>;
}
