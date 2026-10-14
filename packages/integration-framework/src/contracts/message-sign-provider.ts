import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { MessageSign } from "@openmapx/mobility-core/message-sign";
import type { OperationalEvidence } from "./operational-evidence.js";

export type {
  MessageSign,
  MessageSignStatus,
  MessageSignType,
} from "@openmapx/mobility-core/message-sign";

export interface MessageSignQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "message-signs" capability: the dynamic message signs along the
 * roads and what each shows now. The first-party `message-signs`
 * orchestrator merges every registered provider behind the `message-signs`
 * data source; consumers depend only on this contract.
 *
 * A provider dedups its own signs; the orchestrator does not dedup across
 * providers and re-applies the excluded sources itself.
 */
export interface MessageSignProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when signs may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchSigns(
    bbox: BBox,
    q?: MessageSignQuery,
  ): Promise<{ signs: MessageSign[]; partial?: DataSourcePartialReason }>;
  /** The sign with this id, or null when this provider does not hold it. */
  getSign(id: string, q?: MessageSignQuery): Promise<MessageSign | null>;
  /** The state of the feeds behind the signs, for the coverage report. */
  getOperationalEvidence?(): Promise<OperationalEvidence>;
}
