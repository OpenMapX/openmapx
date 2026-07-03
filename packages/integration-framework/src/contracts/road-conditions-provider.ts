import type {
  BBox,
  RoadConditionAttribution,
  RoadConditionEvent,
  RoadConditionsQuery,
} from "@openmapx/core";

export type {
  RoadConditionAttribution,
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionSchedule,
  RoadConditionSeverity,
  RoadConditionsQuery,
  RoadConditionType,
  RoadState,
} from "@openmapx/core";

/**
 * Pluggable "road conditions" capability. Multiple integrations implement this
 * — OpenConditions (reading the shared PostGIS `conditions.observations` table),
 * or live third-party APIs (TomTom/HERE/Waze) — and the first-party
 * `road-conditions` orchestrator merges them behind one `/events` route consumed
 * by both the map overlay and turn-by-turn navigation.
 *
 * Providers map their native shape onto `RoadConditionEvent`; consumers depend
 * only on this contract, never on any provider's package.
 */
export interface RoadConditionsProvider {
  /** The OpenMapX integration id (e.g. "road-conditions-openconditions"). */
  readonly id: string;
  /** Provider-level attribution (per-event `attribution` takes precedence). */
  readonly attribution?: RoadConditionAttribution[];
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  getEvents(bbox: BBox, opts?: RoadConditionsQuery): Promise<RoadConditionEvent[]>;
}
