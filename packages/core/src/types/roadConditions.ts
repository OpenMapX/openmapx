import type { Geometry, LineString } from "geojson";
import type { RoadConditionEffect, VehicleApplicability } from "../utils/roadConditionEffects";

export type { RoadConditionEffect, VehicleApplicability };

/** A text in every language its publisher wrote it in, the publisher's own first. */
export type LocalizedText = { lang: string; text: string }[];

/** How severe a situation is, mildest first; `unknown` ranks below every label. */
export type RoadConditionSeverityLabel = "minor" | "moderate" | "major" | "critical" | "unknown";

/** Per-event provenance, carried through to attribution UI + legal tables. */
export interface RoadConditionAttribution {
  /** Human-readable provider/feed name (e.g. "NDW", "TomTom"). */
  provider: string;
  license?: string;
  url?: string;
}

export interface RoadConditionRoadRef {
  ref?: string;
  name?: LocalizedText;
  /** OSM-style road class (motorway, trunk, primary, …). */
  class?: string;
  from?: string;
  to?: string;
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

/**
 * When a situation (or one of its effects) holds: the source's declared
 * lifecycle, its outer bounds, and recurring windows inside them. Whether it
 * holds at an instant is `validityHoldsAt`, never `status` alone.
 */
export interface RoadConditionValidity {
  status: "planned" | "active" | "suspended" | "ended" | "cancelled" | "unknown";
  start?: string;
  end?: string;
  estimatedEnd?: string;
  /** In effect only inside one of these windows. */
  periods?: RoadConditionSchedule[];
  /** Never in effect inside these windows. */
  exceptions?: RoadConditionSchedule[];
}

/** How well an effect was bound to the road graph; only `exact` and `likely` route. */
export type RoadConditionBindingStatus =
  | "exact"
  | "likely"
  | "ambiguous"
  | "unresolved"
  | "no_coverage"
  | "not_applicable"
  | "unattempted"
  | "obsolete"
  | "invalid";

/**
 * Versioned routing evidence of one effect of one record revision, as
 * OpenConditions publishes it: where it is bound, under which rights, until
 * when. snake_case matches the OC wire contract.
 */
export interface RoadConditionRoutingEvidence {
  schema_version: 2;
  record_class: "situation";
  record_id: string;
  effect_id: string;
  record_revision: number;
  /** The record revision the binding resolved. */
  binding_revision: number;
  effect_kind: string;
  graph_generation: string;
  resolver_version: string;
  source_id: string;
  child_source_id: string | null;
  source_license: string;
  license_url: string | null;
  attribution: string | null;
  record_url: string | null;
  source_checked_at: string;
  fresh_until: string;
  expires_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  next_transition_at: string | null;
  direction_mode: "forward" | "reverse" | "both" | "unknown";
  applicability: VehicleApplicability;
  rights: {
    source_redistribution: "yes" | "no" | "unknown";
    derived_redistribution: "yes" | "no" | "unknown";
    commercial_use: "yes" | "no" | "unknown";
    attribution_required: "yes" | "no" | "unknown";
    retention: "yes" | "no" | "unknown";
    evidence_origin: string | null;
    evidence_version: string | null;
    reviewed_at: string | null;
  };
  segments: Array<{
    segment_id: string;
    direction: "forward" | "reverse";
    from_fraction: number;
    to_fraction: number;
  }>;
  binding_status: RoadConditionBindingStatus;
  reason_codes: string[];
  evaluated_at: string;
}

/**
 * One road situation — an incident, works, a closure, a hazard — as a
 * road-conditions provider publishes it: classified by the conditions
 * registry (`kind`/`type`/`subtype`), with what it does to traffic as typed
 * `effects`. Consumers read the effects (`closesRoadForCars`, `speedCapKph`,
 * `effectInForceAt`, …), never a summary of them.
 */
export interface RoadConditionEvent {
  /** Globally unique, provider-prefixed (e.g. "oc:situation:nl-ndw:RWS01_…"). */
  id: string;
  /** Upstream feed/source id (e.g. "nl-ndw", "ca-bc-drivebc"). */
  source: string;
  /** OpenMapX integration id that produced it — stamped by the orchestrator. */
  provider: string;
  /**
   * Provider-supplied display relationship for situations split from one
   * source situation. It is not a canonical id, deduplication key, or routing input.
   */
  groupId?: string;
  /** Registry kind (incident, roadworks, closure, restriction, …). */
  kind: string;
  /** Registry type within the kind (accident, works, closure, …). */
  type: string;
  subtype?: string;
  severity: { label: RoadConditionSeverityLabel; level?: number };
  certainty: "observed" | "likely" | "possible" | "unlikely" | "unknown";
  /** Happening now, announced for later, or a forecast. */
  temporality: "live" | "scheduled" | "forecast";
  /** Scheduled work rather than an unplanned incident; orthogonal to timing. */
  planned: boolean;
  headline?: LocalizedText;
  description?: LocalizedText;
  /** WGS84 [lon,lat] geometry. */
  geometry: Geometry;
  roads?: RoadConditionRoadRef[];
  direction?: { value: string; compass?: string; text?: string };
  validity: RoadConditionValidity;
  effects: RoadConditionEffect[];
  /** `feed` = an authoritative official source, `crowd` = user reports. */
  origin: "feed" | "crowd" | "federation" | "derived";
  /** A crowd situation's evidence: how far it was corroborated, whether it may route. */
  evidence?: { state: string; confidenceScore?: number; routingEligible?: boolean };
  attribution: RoadConditionAttribution;
  /** When the source last changed the situation. */
  updatedAt?: string;
  fetchedAt: string;
  expiresAt?: string;
  /**
   * Routing evidence per effect id. A provider's routing read carries it or
   * fails; a display read carries it when it could be read. An effect without
   * evidence has no current, authorized binding and never routes.
   */
  routingEvidence?: Record<string, RoadConditionRoutingEvidence>;
}

export interface RoadConditionsQuery {
  /** Original sources excluded before provider-side representative selection. */
  excludedSourceIds?: string[];
  kinds?: string[];
  types?: string[];
  minSeverity?: RoadConditionSeverityLabel;
  /**
   * Keep only situations starting within the next `n` days (`0` = active now).
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
