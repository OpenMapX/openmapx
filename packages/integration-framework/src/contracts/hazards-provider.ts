import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type {
  FireDensityCell,
  FireInstrument,
  FirePixel,
  HazardAlert,
  NaturalHazard,
  NaturalHazardType,
} from "@openmapx/mobility-core/hazards";
import type { OperationalEvidence } from "./operational-evidence.js";

export type {
  CapSeverity,
  FireDensityCell,
  FireInstrument,
  FirePixel,
  HazardAlert,
  NaturalHazard,
  NaturalHazardType,
} from "@openmapx/mobility-core/hazards";

export interface HazardsQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
  /** The language the texts are wanted in (BCP 47); a text without it comes in the first language it carries. */
  lang?: string;
}

/**
 * Pluggable "hazards" capability: weather and civil-protection alerts,
 * natural hazards, and satellite fire detections. The `hazards` orchestrator
 * merges every registered provider; the overlays depend only on this
 * contract, never on a provider's package.
 *
 * A bbox has `west <= east`: the orchestrator splits a view that crosses the
 * antimeridian before it asks. The query is a hint a provider may push into
 * its upstream; the orchestrator re-applies the exclusions itself.
 */
export interface HazardsProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * The current alerts. `simplifyDeg` asks for geometries simplified to that
   * tolerance in degrees. `partial` is set when alerts may be missing.
   */
  getAlerts(
    bbox: BBox,
    q?: HazardsQuery & { simplifyDeg?: number },
  ): Promise<{ alerts: HazardAlert[]; partial?: DataSourcePartialReason }>;
  /**
   * Natural hazards of these types, current or, with `since`, ended no earlier
   * than that ISO instant.
   */
  getNaturalHazards(
    bbox: BBox,
    q: HazardsQuery & {
      types: readonly NaturalHazardType[];
      subtypes?: readonly string[];
      since?: string;
      simplifyDeg?: number;
    },
  ): Promise<{ hazards: NaturalHazard[]; partial?: DataSourcePartialReason }>;
  /** Fire detections observed since the ISO instant, at most `limit`. */
  getFirePixels(
    bbox: BBox,
    q: HazardsQuery & { since: string; instrument: FireInstrument; limit: number },
  ): Promise<{ pixels: FirePixel[]; partial?: DataSourcePartialReason }>;
  /** Fire detections since the ISO instant, aggregated into `cellDeg` cells. */
  getFireDensity(
    bbox: BBox,
    q: HazardsQuery & { since: string; instrument: FireInstrument; cellDeg: number },
  ): Promise<{
    cells: FireDensityCell[];
    /** The ids of the sources the cells were built from. */
    sources: string[];
    partial?: DataSourcePartialReason;
  }>;
  /** The state of the feeds behind the hazards, for the coverage report. */
  getOperationalEvidence?(): Promise<OperationalEvidence>;
}
