import type {
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRoutingEvidence,
} from "../../../types/roadConditions";

/** One effect of the fixture situation; `fields` replaces or adds keys. */
export const effect = (
  id: string,
  kind: RoadConditionEffect["kind"],
  fields: Record<string, unknown> = {},
): RoadConditionEffect =>
  ({
    id,
    kind,
    v: 1,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
    ...(kind === "closure" ? { scope: "road" } : {}),
    ...fields,
  }) as RoadConditionEffect;

/** Routing evidence of one effect of the fixture situation, current at 2026-09-11T12:00Z. */
export const evidence = (
  effectId = "fr1/closure",
  effectKind = "closure",
): RoadConditionRoutingEvidence => ({
  schema_version: 2,
  record_class: "situation",
  record_id: "oc:situation:fr:fr1",
  effect_id: effectId,
  record_revision: 3,
  binding_revision: 3,
  effect_kind: effectKind,
  graph_generation: "g1",
  resolver_version: "2.0.0",
  source_id: "fr",
  child_source_id: null,
  source_license: "etalab-2.0",
  license_url: "https://example.org/license",
  attribution: "DIR",
  record_url: null,
  source_checked_at: "2026-09-11T11:59:00Z",
  fresh_until: "2026-09-11T12:10:00Z",
  expires_at: null,
  valid_from: null,
  valid_to: null,
  next_transition_at: null,
  direction_mode: "both",
  applicability: { kind: "all" },
  rights: {
    commercial_use: "yes",
    source_redistribution: "yes",
    derived_redistribution: "yes",
    attribution_required: "yes",
    retention: "yes",
    evidence_origin: "publisher",
    evidence_version: "1",
    reviewed_at: "2026-09-11T00:00:00Z",
  },
  segments: [{ segment_id: "10", direction: "forward", from_fraction: 0, to_fraction: 1 }],
  binding_status: "exact",
  reason_codes: [],
  evaluated_at: "2026-09-11T12:00:00Z",
});

/** A full feed closure of one road, bound and with current routing evidence. */
export const event = (): RoadConditionEvent => ({
  id: "oc:situation:fr:fr1",
  source: "fr",
  provider: "road-conditions-openconditions",
  kind: "closure",
  type: "closure",
  subtype: "full",
  severity: { label: "major" },
  certainty: "observed",
  temporality: "live",
  planned: false,
  headline: [{ lang: "fr", text: "Route fermée" }],
  geometry: { type: "Point", coordinates: [2, 48] },
  validity: { status: "active", start: "2026-09-11T08:00:00Z" },
  effects: [effect("fr1/closure", "closure")],
  origin: "feed",
  attribution: { provider: "DIR", license: "etalab-2.0" },
  fetchedAt: "2026-09-11T11:59:00Z",
  routingEvidence: { "fr1/closure": evidence() },
});

/** The fixture situation's one effect. */
export const closure = (e: RoadConditionEvent = event()): RoadConditionEffect => e.effects[0]!;
