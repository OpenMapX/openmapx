import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { ServiceVehicle } from "@openmapx/mobility-core/service-vehicle";

export type {
  ServiceVehicle,
  ServiceVehicleActivity,
} from "@openmapx/mobility-core/service-vehicle";

export interface ServiceVehicleQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "service-vehicles" capability: where the road service vehicles
 * an authority tracks (snowploughs, spreaders, maintenance trucks) are now
 * and what they are doing. The first-party `road-maintenance` orchestrator
 * merges every registered provider behind the `road-maintenance` data
 * source; consumers depend only on this contract.
 *
 * A position stands only until it expires, so a vehicle found by a search
 * may be gone when it is read by id. The orchestrator does not dedup across
 * providers and re-applies the excluded sources itself.
 */
export interface ServiceVehicleProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when vehicles may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchVehicles(
    bbox: BBox,
    q?: ServiceVehicleQuery,
  ): Promise<{ vehicles: ServiceVehicle[]; partial?: DataSourcePartialReason }>;
  /** The vehicle position with this id, or null when it is gone or this provider does not hold it. */
  getVehicle(id: string, q?: ServiceVehicleQuery): Promise<ServiceVehicle | null>;
}
