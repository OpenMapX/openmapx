import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { ParkingSite } from "@openmapx/mobility-core/parking";
import type { OperationalEvidence } from "./operational-evidence.js";

export type {
  ParkingArea,
  ParkingCounts,
  ParkingLayout,
  ParkingRate,
  ParkingSite,
  ParkingSiteType,
  ParkingStatus,
  ParkingTrend,
} from "@openmapx/mobility-core/parking";

export interface ParkingSiteQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "parking sites" capability: parking facilities with their areas,
 * live counts and tariffs. The first-party `parking` orchestrator merges every
 * registered provider behind the `parking` data source; consumers depend only
 * on this contract, never on a provider's package.
 *
 * A provider dedups its own sites; the orchestrator does not dedup across
 * providers. The query is a hint a provider may push into its upstream — the
 * orchestrator re-applies every filter itself.
 */
export interface ParkingSiteProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when sites may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchSites(
    bbox: BBox,
    q?: ParkingSiteQuery,
  ): Promise<{ sites: ParkingSite[]; partial?: DataSourcePartialReason }>;
  /**
   * The site with this id, or null when this provider does not hold it.
   * The excluded sources are taken out as a search takes them out, so a
   * site opens with the same sources it was listed with.
   */
  getSite(id: string, q?: ParkingSiteQuery): Promise<ParkingSite | null>;
  /** The state of the feeds behind the sites, for the coverage report. */
  getOperationalEvidence?(): Promise<OperationalEvidence>;
}
