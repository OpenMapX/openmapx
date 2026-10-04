import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";

export type { FuelProduct, FuelStation } from "@openmapx/mobility-core/fuel";

export interface FuelStationQuery {
  /** Only stations with at least one priced product. */
  pricesOnly?: boolean;
  /** Only stations selling at least one of these grades. */
  grades?: readonly string[];
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "fuel stations" capability: stations with their products, prices
 * and availability. The first-party `fuel` orchestrator merges every
 * registered provider behind the `fuel` data source; consumers depend only on
 * this contract, never on a provider's package.
 *
 * A provider dedups its own stations; the orchestrator does not dedup across
 * providers. The query is a hint a provider may push into its upstream — the
 * orchestrator re-applies every filter itself.
 */
export interface FuelStationProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when stations may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchStations(
    bbox: BBox,
    q?: FuelStationQuery,
  ): Promise<{ stations: FuelStation[]; partial?: DataSourcePartialReason }>;
  /**
   * The station with this id, or null when this provider does not hold it.
   * The excluded sources are taken out as a search takes them out, so a
   * station opens with the same sources it was listed with.
   */
  getStation(
    id: string,
    q?: Pick<FuelStationQuery, "excludedSourceIds">,
  ): Promise<FuelStation | null>;
}
