import type {
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRoutingEvidence,
} from "@openmapx/core";

/** One effect of a fixture situation; `fields` replaces or adds keys. */
export const effect = (
  id: string,
  kind: RoadConditionEffect["kind"] = "closure",
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

/** A fixture situation's first effect. */
export function firstEffect(event: RoadConditionEvent): RoadConditionEffect {
  const [first] = event.effects;
  if (!first) throw new Error(`fixture situation ${event.id} has no effect`);
  return first;
}

/** A situation that closes its road for every vehicle, with no routing evidence. */
export function roadConditionEvent(
  overrides: Partial<RoadConditionEvent> = {},
): RoadConditionEvent {
  const id = overrides.id ?? "test:1";
  return {
    id,
    source: "test",
    provider: "road-conditions-test",
    kind: "closure",
    type: "closure",
    severity: { label: "major" },
    certainty: "observed",
    temporality: "live",
    planned: false,
    headline: [{ lang: "en", text: "Road closed" }],
    geometry: { type: "Point", coordinates: [0.5, 51.5] },
    validity: { status: "active" },
    effects: [effect(`${id}/closure`)],
    origin: "feed",
    attribution: { provider: "Test" },
    fetchedAt: "2026-09-12T11:59:00Z",
    ...overrides,
  };
}

/** Routing evidence of `effectId` of situation `recordId`, current at 2026-09-12T12:00Z. */
export function routingEvidence(
  recordId: string,
  effectId: string,
  overrides: Partial<RoadConditionRoutingEvidence> = {},
): RoadConditionRoutingEvidence {
  return {
    schema_version: 2,
    record_class: "situation",
    record_id: recordId,
    effect_id: effectId,
    record_revision: 1,
    binding_revision: 1,
    effect_kind: "closure",
    graph_generation: "graph-1",
    resolver_version: "resolver-1",
    source_id: "oc-parent",
    child_source_id: "oc-child",
    source_license: "CC BY 4.0",
    license_url: "https://example.test/license",
    attribution: "Example road authority",
    record_url: null,
    source_checked_at: "2026-09-12T11:55:00Z",
    fresh_until: "2026-09-12T12:05:00Z",
    expires_at: "2026-09-12T12:10:00Z",
    valid_from: "2026-09-12T11:00:00Z",
    valid_to: "2026-09-12T13:00:00Z",
    next_transition_at: null,
    direction_mode: "both",
    applicability: { kind: "all" },
    rights: {
      source_redistribution: "yes",
      derived_redistribution: "yes",
      commercial_use: "yes",
      attribution_required: "yes",
      retention: "yes",
      evidence_origin: "source-catalogue",
      evidence_version: "1",
      reviewed_at: "2026-09-01T00:00:00Z",
    },
    segments: [
      { segment_id: "1:f", direction: "forward", from_fraction: 0, to_fraction: 1 },
      { segment_id: "1:b", direction: "reverse", from_fraction: 0, to_fraction: 1 },
    ],
    binding_status: "exact",
    reason_codes: [],
    evaluated_at: "2026-09-12T11:55:00Z",
    ...overrides,
  };
}

/**
 * An OpenConditions situation with one effect and its current routing
 * evidence: a full closure unless `fx` says otherwise.
 */
export function boundEvent(
  overrides: Partial<RoadConditionEvent> = {},
  fx: RoadConditionEffect = effect("oc:1/closure"),
  evidence: Partial<RoadConditionRoutingEvidence> = {},
): RoadConditionEvent {
  const id = overrides.id ?? "oc:1";
  return roadConditionEvent({
    id,
    source: "oc-child",
    provider: "road-conditions-openconditions",
    effects: [fx],
    routingEvidence: {
      [fx.id]: routingEvidence(id, fx.id, { effect_kind: fx.kind, ...evidence }),
    },
    ...overrides,
  });
}
