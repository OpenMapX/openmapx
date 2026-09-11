import type { RoadConditionEvent, RoadConditionRoutingEvidence } from "../types/roadConditions";
import { isRoutingRelevantBinding } from "./edgeClosure";

/** Validate untrusted JSON before it can replace an accepted snapshot. */
export function isRoadConditionRoutingEvidence(
  value: unknown,
): value is RoadConditionRoutingEvidence {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const string = (v: unknown) => typeof v === "string" && v.length <= 8192;
  const nullable = (v: unknown) => v === null || string(v);
  const strings = (v: unknown) => Array.isArray(v) && v.length <= 10000 && v.every(string);
  if (!object(value) || value.schema_version !== 1) return false;
  if (
    ![
      "observation_revision",
      "binding_revision",
      "graph_generation",
      "resolver_version",
      "source_id",
      "source_license",
      "source_checked_at",
      "fresh_until",
      "evaluated_at",
    ].every((k) => string(value[k]))
  )
    return false;
  if (
    ![
      "child_source_id",
      "license_url",
      "attribution",
      "record_url",
      "expires_at",
      "valid_from",
      "valid_to",
      "next_transition_at",
    ].every((k) => nullable(value[k]))
  )
    return false;
  if (
    !["forward", "reverse", "both", "unknown"].includes(value.direction_mode as string) ||
    ![
      "exact",
      "likely",
      "ambiguous",
      "unresolved",
      "no_coverage",
      "not_applicable",
      "unattempted",
      "obsolete",
      "invalid",
    ].includes(value.binding_status as string)
  )
    return false;
  const instant = (v: unknown) =>
    typeof v === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
  if (
    !["source_checked_at", "fresh_until", "evaluated_at"].every((k) => instant(value[k])) ||
    !["expires_at", "valid_from", "valid_to", "next_transition_at"].every(
      (k) => value[k] === null || instant(value[k]),
    )
  )
    return false;
  const a = value.applicability;
  if (
    !object(a) ||
    !["all", "classes", "unknown"].includes(a.kind as string) ||
    (a.classes !== undefined && !strings(a.classes)) ||
    (a.raw !== undefined && !strings(a.raw))
  )
    return false;
  const r = value.rights;
  if (
    !object(r) ||
    ![
      "source_redistribution",
      "derived_redistribution",
      "commercial_use",
      "attribution_required",
      "retention",
    ].every((k) => ["yes", "no", "unknown"].includes(r[k] as string)) ||
    !["evidence_origin", "evidence_version", "reviewed_at"].every((k) => nullable(r[k]))
  )
    return false;
  if (r.reviewed_at !== null && !instant(r.reviewed_at)) return false;
  return (
    strings(value.reason_codes) &&
    Array.isArray(value.segments) &&
    value.segments.length <= 10000 &&
    value.segments.every(
      (s) =>
        object(s) &&
        string(s.segment_id) &&
        ["forward", "reverse"].includes(s.direction as string) &&
        typeof s.from_fraction === "number" &&
        Number.isFinite(s.from_fraction) &&
        typeof s.to_fraction === "number" &&
        Number.isFinite(s.to_fraction) &&
        s.from_fraction >= 0 &&
        s.to_fraction <= 1 &&
        s.from_fraction <= s.to_fraction,
    )
  );
}

/** Eligibility is evidence, not proof that a particular engine applied the effect. */
export function getRoadConditionRoutingDecision(
  event: Pick<
    RoadConditionEvent,
    "source" | "routingEvidence" | "originKind" | "routingEligible" | "isStale" | "schedule"
  >,
  options: {
    evaluatedAt?: number;
    travelAt?: number;
    disallowedSources?: ReadonlySet<string>;
    sharedTraffic?: boolean;
  } = {},
): { eligible: boolean; reasons: string[]; validUntil: string | null } {
  const now = options.evaluatedAt ?? Date.now();
  const travel = options.travelAt ?? now;
  const e = event.routingEvidence;
  if (!e || e.schema_version !== 1)
    return { eligible: false, reasons: ["missing_routing_evidence"], validUntil: null };
  if (!isRoadConditionRoutingEvidence(e))
    return { eligible: false, reasons: ["invalid_routing_evidence"], validUntil: null };
  const reasons: string[] = [];
  const deadlines: number[] = [];
  const parseTime = (value: string | null | undefined, required = false): number | null => {
    if (value == null && !required) return null;
    const n =
      typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(n)) {
      reasons.push("invalid_time");
      return null;
    }
    return n;
  };
  if (!Number.isFinite(now) || !Number.isFinite(travel)) reasons.push("invalid_time");
  if (
    options.disallowedSources?.has(event.source) ||
    options.disallowedSources?.has(e.source_id) ||
    (e.child_source_id && options.disallowedSources?.has(e.child_source_id))
  )
    reasons.push("source_excluded");
  if (!e.source_id || !e.source_license || event.source !== (e.child_source_id ?? e.source_id))
    reasons.push("invalid_source_identity");
  if (
    event.originKind !== "feed" &&
    !(event.originKind === "crowd" && event.routingEligible === true)
  )
    reasons.push("unconfirmed_origin");
  if (!isRoutingRelevantBinding(e.binding_status)) reasons.push("binding_not_routable");
  if (
    !e.observation_revision ||
    e.observation_revision !== e.binding_revision ||
    !e.graph_generation ||
    !e.resolver_version
  )
    reasons.push("obsolete_binding");
  if (!["forward", "reverse", "both"].includes(e.direction_mode)) reasons.push("unknown_direction");
  if (e.applicability?.kind !== "all") reasons.push("unsupported_vehicle_scope");
  if (
    !e.rights ||
    e.rights.source_redistribution !== "yes" ||
    e.rights.derived_redistribution !== "yes" ||
    e.rights.commercial_use !== "yes" ||
    e.rights.retention !== "yes" ||
    !e.rights.evidence_origin ||
    !e.rights.evidence_version ||
    !e.rights.reviewed_at ||
    !e.license_url ||
    (e.rights.attribution_required !== "no" && !e.attribution)
  )
    reasons.push("unverified_rights");
  const checked = parseTime(e.source_checked_at, true);
  const fresh = parseTime(e.fresh_until, true);
  const expiry = parseTime(e.expires_at);
  const start = parseTime(e.valid_from);
  const end = parseTime(e.valid_to);
  const transition = parseTime(e.next_transition_at);
  if (checked !== null && checked > now) reasons.push("invalid_time");
  if (event.isStale || (fresh !== null && (fresh <= now || (checked !== null && fresh <= checked))))
    reasons.push("stale_source");
  if (expiry !== null && expiry <= now) reasons.push("expired_observation");
  if ((start !== null && travel < start) || (end !== null && travel >= end))
    reasons.push("outside_validity");
  if (start !== null && end !== null && start >= end) reasons.push("invalid_time");
  if (event.schedule?.length && transition === null) reasons.push("unsupported_schedule");
  if (travel === now && transition !== null && transition <= now) reasons.push("expired_window");
  for (const d of [fresh, expiry, travel === now ? end : null, travel === now ? transition : null])
    if (d !== null) deadlines.push(d);
  if (
    !Array.isArray(e.segments) ||
    e.segments.length === 0 ||
    e.segments.some(
      (s) =>
        !s.segment_id ||
        !["forward", "reverse"].includes(s.direction) ||
        !Number.isFinite(s.from_fraction) ||
        !Number.isFinite(s.to_fraction) ||
        s.from_fraction < 0 ||
        s.to_fraction > 1 ||
        s.from_fraction > s.to_fraction,
    )
  )
    reasons.push("invalid_spans");
  if (e.reason_codes?.length) reasons.push(...e.reason_codes);
  const validUntil = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  return {
    eligible: reasons.length === 0 && validUntil !== null,
    reasons: [...new Set(reasons)],
    validUntil,
  };
}
