import type { BBox } from "@openmapx/core";
import type { Geometry } from "geojson";

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

export type RoadConditionType =
  | "accident"
  | "roadworks"
  | "road_closure"
  | "lane_closure"
  | "hazard"
  | "congestion"
  | "weather"
  | "event"
  | "restriction"
  | "other";

export type RoadConditionSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export type RoadState = "open" | "closed" | "some_lanes_closed" | "single_lane_alternating";

/** Per-event provenance, carried through to attribution UI + legal tables. */
export interface RoadConditionAttribution {
  /** Human-readable provider/feed name (e.g. "NDW", "TomTom"). */
  provider: string;
  license?: string;
  url?: string;
}

export interface RoadConditionRoadRef {
  name: string;
  direction?: string;
}

/**
 * One recurring validity window: within [dateStart, dateEnd] (inclusive ISO
 * dates), on the listed `dayOfWeek` (0=Sun..6=Sat; all days when absent), active
 * each day from `timeStart` to `timeEnd` (local "HH:MM"; an overnight band wraps
 * when timeEnd < timeStart). Mirrors the conditions model's `RecurringWindow`.
 */
export interface RoadConditionScheduleWindow {
  dayOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  dateStart?: string;
  dateEnd?: string;
}

export interface RoadConditionEvent {
  /** Globally unique, provider-prefixed (e.g. "ndw:NL123", "tomtom:abc"). */
  id: string;
  /** Upstream feed/source id (e.g. "ndw", "drivebc", "tomtom"). */
  source: string;
  /** OpenMapX integration id that produced it — stamped by the orchestrator. */
  provider: string;
  type: RoadConditionType;
  severity: RoadConditionSeverity;
  /** WGS84 [lon,lat] geometry. */
  geometry: Geometry;
  headline: string;
  description?: string;
  roadState?: RoadState;
  roads?: RoadConditionRoadRef[];
  validFrom?: string | null;
  validTo?: string | null;
  /** Fine-grained recurring windows (e.g. nightly closures); when present, the
   * event is in effect only inside a window, not across the whole from–to span. */
  schedule?: RoadConditionScheduleWindow[];
  dataUpdatedAt?: string;
  attribution?: RoadConditionAttribution;
}

export interface RoadConditionsQuery {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
}

export interface RoadConditionsProvider {
  /** The OpenMapX integration id (e.g. "road-conditions-openconditions"). */
  readonly id: string;
  /** Provider-level attribution (per-event `attribution` takes precedence). */
  readonly attribution?: RoadConditionAttribution[];
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  getEvents(bbox: BBox, opts?: RoadConditionsQuery): Promise<RoadConditionEvent[]>;
}
