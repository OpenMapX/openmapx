import type { BoundingBox } from "../overpass.service";
import type { FuelStation } from "./types";

export interface FuelPriceProvider {
  readonly name: string;
  /** Returns true if this provider covers the given bounding box. */
  supports(bbox: BoundingBox): boolean;
  /** Fetches fuel stations with prices within the bounding box. */
  searchStations(bbox: BoundingBox): Promise<FuelStation[]>;
}
