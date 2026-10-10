import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { ChargingSite } from "@openmapx/mobility-core/ev-charging";
import type { OperationalEvidence } from "./operational-evidence.js";

export type {
  ChargingConnector,
  ChargingSite,
  EnergyTariff,
  EnergyTariffRestrictions,
  Evse,
  EvseStatus,
} from "@openmapx/mobility-core/ev-charging";

export interface ChargingSiteQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
  /** Upper bound on the sites returned. */
  maxSites?: number;
}

/**
 * Pluggable "charging sites" capability: charging sites with their EVSEs,
 * connectors, live status and tariffs. The first-party `ev-charging`
 * orchestrator merges every registered provider behind the `ev-charging` data
 * source; consumers depend only on this contract, never on a provider's
 * package.
 *
 * A provider dedups its own sites; the orchestrator does not dedup across
 * providers. The query is a hint a provider may push into its upstream — the
 * orchestrator re-applies every filter itself.
 */
export interface ChargingSiteProvider {
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
    q?: ChargingSiteQuery,
  ): Promise<{ sites: ChargingSite[]; partial?: DataSourcePartialReason }>;
  /**
   * The site with this id, or null when this provider does not hold it.
   * The excluded sources are taken out as a search takes them out, so a
   * site opens with the same sources it was listed with.
   */
  getSite(id: string, q?: ChargingSiteQuery): Promise<ChargingSite | null>;
  /** The state of the feeds behind the sites, for the coverage report. */
  getOperationalEvidence?(): Promise<OperationalEvidence>;
}
