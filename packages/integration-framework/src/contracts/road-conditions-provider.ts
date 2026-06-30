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
 * A recurring validity rule, shaped after schema.org `Schedule`
 * (https://schema.org/Schedule). Local fields (`startTime`, `startDate`/
 * `endDate`, `byDay`) are interpreted in `scheduleTimezone` (an IANA name), so
 * the rule is DST-correct and self-describing. `duration` is the authoritative
 * occurrence length (overnight-safe, e.g. "PT9H"); `endTime` is an optional
 * human-readable convenience. Mirrors the conditions model's `Schedule`.
 */
export interface RoadConditionSchedule {
  /** ISO 8601 duration between occurrences: "P1D" daily, "P1W" weekly. */
  repeatFrequency?: string;
  repeatCount?: number;
  /** Local ISO date the recurrence starts / last starts. */
  startDate?: string;
  endDate?: string;
  /** Local time-of-day each occurrence starts ("HH:MM"[:SS]). */
  startTime?: string;
  /** Optional local end time-of-day (human-readable; `duration` is authoritative). */
  endTime?: string;
  /** ISO 8601 duration of each occurrence, e.g. "PT9H". */
  duration?: string;
  /** Days of week as two-letter iCal codes (SU MO TU WE TH FR SA). */
  byDay?: string[];
  byMonth?: number[];
  byMonthDay?: number[];
  exceptDate?: string[];
  /** IANA timezone the local fields above are expressed in. */
  scheduleTimezone: string;
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
  /** Fine-grained recurring schedule (e.g. nightly closures); when present, the
   * event is in effect only inside a window, not across the whole from–to span. */
  schedule?: RoadConditionSchedule[];
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
