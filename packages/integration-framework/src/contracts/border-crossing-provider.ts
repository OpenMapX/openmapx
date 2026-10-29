import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { BorderCrossing } from "@openmapx/mobility-core/border-crossing";

export type {
  BorderCrossing,
  BorderCrossingMode,
  BorderCrossingProgram,
  BorderCrossingQueue,
  BorderWaitStatus,
} from "@openmapx/mobility-core/border-crossing";

export interface BorderCrossingQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "border-crossings" capability: the land border crossings and how
 * long their queues are now, each way. The first-party `border-crossings`
 * orchestrator merges every registered provider behind the
 * `border-crossings` data source; consumers depend only on this contract.
 *
 * A provider dedups its own crossings (one crossing whose two countries each
 * publish their queues is one crossing); the orchestrator does not dedup
 * across providers and re-applies the excluded sources itself.
 */
export interface BorderCrossingProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when crossings may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchCrossings(
    bbox: BBox,
    q?: BorderCrossingQuery,
  ): Promise<{ crossings: BorderCrossing[]; partial?: DataSourcePartialReason }>;
  /** The crossing with this id, or null when this provider does not hold it. */
  getCrossing(id: string, q?: BorderCrossingQuery): Promise<BorderCrossing | null>;
}
