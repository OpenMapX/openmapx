import type { Geometry, LineString } from "geojson";

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
  /** Estimated delay in seconds this event adds vs. free flow (DATEX delayTimeValue),
   * where the source reports it. Undefined when the feed carries no delay. */
  delaySeconds?: number;
  roadState?: RoadState;
  roads?: RoadConditionRoadRef[];
  validFrom?: string | null;
  validTo?: string | null;
  /** Fine-grained recurring schedule (e.g. nightly closures); when present, the
   * event is in effect only inside a window, not across the whole from–to span. */
  schedule?: RoadConditionSchedule[];
  dataUpdatedAt?: string;
  attribution?: RoadConditionAttribution;
  /**
   * Provenance kind, set by crowd-aware providers (e.g. OpenConditions):
   * `"feed"` = an authoritative official source, `"crowd"` = a user report.
   * Official third-party providers that predate this field leave it undefined.
   * Drives the routing gate (only a crowd event can be withheld from routing)
   * and the overlay's "unconfirmed" labeling. See `integrations/routing/closures.ts`.
   */
  originKind?: "feed" | "crowd";
  /**
   * Whether a crowd-origin event has been corroborated strongly enough to affect
   * routing (an external resolution — peer corroboration alone never sets it).
   * Feed events are authoritative and leave this undefined. Only meaningful when
   * `originKind === "crowd"`.
   */
  routingEligible?: boolean;
  /**
   * Evidence maturity of a crowd report (e.g. `"self_reported"`,
   * `"externally_resolved"`). Used by the overlay to label unconfirmed crowd
   * events distinctly; undefined for feed events.
   */
  evidenceState?: string;
  /** Aggregate confidence score for a crowd event (0..1); undefined for feeds. */
  confidenceScore?: number;
  /**
   * The source announced this condition before it takes effect (e.g. Autobahn's
   * `future` flag). Usually agrees with a `validFrom` in the future, but sources
   * set it independently of how precise their dates are, so the overlay treats
   * it as a second signal rather than deriving "upcoming" from dates alone.
   */
  isForecast?: boolean;
  /**
   * Scheduled work rather than an unplanned incident. Orthogonal to timing — a
   * roadworks site in effect right now is `isPlanned` with a past `validFrom`.
   */
  isPlanned?: boolean;
}

export interface RoadConditionsQuery {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
  /**
   * Keep only conditions in effect within the next `n` days (`0` = active now).
   * Undefined means no temporal filter. Routing must keep it undefined: it
   * evaluates validity at the chosen travel time and needs future closures.
   */
  horizonDays?: number;
}

export interface RoadFlowSegment {
  /** segment_id */
  id: string;
  geometry: LineString;
  currentSpeedKph?: number;
  freeFlowSpeedKph?: number;
  /** 0..~1.2 */
  speedRatio?: number;
  los: "free_flow" | "heavy" | "queuing" | "stationary" | "unknown";
  confidence: "measured" | "estimated" | "typical" | "unknown";
  direction: "f" | "b";
  /** ref */
  roads?: string;
  source?: string;
  /** ISO */
  observedAt?: string;
}

export interface RoadFlowQuery {
  minLos?: string;
}

/**
 * A stretch of one route where traffic is worse (or better) than free flow,
 * expressed as metres along the polyline that was submitted. The client slices
 * that polyline by these offsets, so the painted band lands exactly on the
 * drawn line rather than on the road segment's own geometry.
 */
export interface RouteFlowSpan {
  startMeters: number;
  endMeters: number;
  los: RoadFlowSegment["los"];
  speedRatio?: number;
  confidence: RoadFlowSegment["confidence"];
  currentSpeedKph?: number;
  freeFlowSpeedKph?: number;
}

/** One route submitted for flow matching. `id` is echoed back on the response. */
export interface RouteFlowInput {
  id: string;
  geometry: [number, number][];
}

export interface RouteFlowResponse {
  routes: Array<{ id: string; spans: RouteFlowSpan[] }>;
}
