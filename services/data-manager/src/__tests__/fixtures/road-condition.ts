import type {
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRoutingEvidence,
} from "@openmapx/core";
import type { BoundCondition } from "../../jobs/traffic/conditions-to-edges.js";

export const RECORD_ID = "oc:situation:fr:1";
export const EFFECT_ID = "fr1/closure";

/** One effect; `fields` replaces or adds keys. A full road closure by default. */
export const effect = (
  id = EFFECT_ID,
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

/** A mandatory speed limit for every vehicle. */
export const speedLimit = (kph: number, id = "fr1/speed_limit"): RoadConditionEffect =>
  effect(id, "speed_limit", { limit: { value: kph, unit: "km/h" } });

/** Routing evidence of one effect, current at 2026-09-11T12:00Z, bound to way 10 forward. */
export const evidence = (
  overrides: Partial<RoadConditionRoutingEvidence> = {},
): RoadConditionRoutingEvidence => ({
  schema_version: 2,
  record_class: "situation",
  record_id: RECORD_ID,
  effect_id: EFFECT_ID,
  record_revision: 1,
  binding_revision: 1,
  effect_kind: "closure",
  graph_generation: "g1",
  resolver_version: "r1",
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
  direction_mode: "forward",
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
  segments: [{ segment_id: "10:f", direction: "forward", from_fraction: 0, to_fraction: 1 }],
  binding_status: "exact",
  reason_codes: [],
  evaluated_at: "2026-09-11T12:00:00Z",
  ...overrides,
});

/** A full feed closure of one road, with current routing evidence for its one effect. */
export const event = (): RoadConditionEvent => ({
  id: RECORD_ID,
  source: "fr",
  provider: "road-conditions-openconditions",
  kind: "closure",
  type: "closure",
  severity: { label: "major" },
  certainty: "observed",
  temporality: "live",
  planned: false,
  headline: [{ lang: "fr", text: "Route fermée" }],
  geometry: { type: "Point", coordinates: [2, 48] },
  validity: { status: "active" },
  effects: [effect()],
  origin: "feed",
  attribution: { provider: "DIR", license: "etalab-2.0" },
  fetchedAt: "2026-09-11T11:59:00Z",
  routingEvidence: { [EFFECT_ID]: evidence() },
});

/**
 * One parsed condition: `fx` of situation `recordId`, bound to way 10 forward,
 * with evidence matching both.
 */
export function boundCondition(
  over: Partial<BoundCondition> = {},
  fx: RoadConditionEffect = effect(),
  recordId = RECORD_ID,
): BoundCondition {
  return {
    id: `${recordId}#${fx.id}`,
    recordId,
    source: "fr",
    effect: fx,
    routingEvidence: evidence({ record_id: recordId, effect_id: fx.id, effect_kind: fx.kind }),
    origin: "feed",
    routingEligible: true,
    bindingStatus: "exact",
    segments: [{ wayId: 10, dir: "f", startFraction: 0, endFraction: 1, geometry: null }],
    ...over,
  };
}

/**
 * One `/segments/conditions.json` v2 row for `fx` of situation `recordId`,
 * bound to `wayId` forward from `startFraction` to its end, with evidence that
 * agrees with the row. `overrides` replaces top-level keys.
 */
export function conditionRow(
  recordId: string,
  options: {
    fx?: RoadConditionEffect;
    wayId?: number;
    startFraction?: number;
    geometry?: [number, number][] | null;
    evidence?: Partial<RoadConditionRoutingEvidence>;
    overrides?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const fx = options.fx ?? effect("closure");
  const wayId = options.wayId ?? 10;
  const startFraction = options.startFraction ?? 0;
  return {
    id: `${recordId}#${fx.id}`,
    record_id: recordId,
    effect_id: fx.id,
    source: "fr",
    kind: "closure",
    type: "closure",
    subtype: null,
    severity: "major",
    effect: fx,
    origin: "feed",
    evidence_state: null,
    routing_eligible: true,
    binding: { status: "exact", confidence: 0.99, direction_mode: "single" },
    routing_evidence: evidence({
      record_id: recordId,
      effect_id: fx.id,
      effect_kind: fx.kind,
      segments: [
        {
          segment_id: `${wayId}:f`,
          direction: "forward",
          from_fraction: startFraction,
          to_fraction: 1,
        },
      ],
      ...options.evidence,
    }),
    segments: [
      {
        way_id: wayId,
        dir: "f",
        start_fraction: startFraction,
        end_fraction: 1,
        geometry: options.geometry ? { type: "LineString", coordinates: options.geometry } : null,
      },
    ],
    ...options.overrides,
  };
}

/** A complete v2 `/segments/conditions.json` body. */
export const conditionsBody = (conditions: unknown[], resolverVersion = "r1"): string =>
  JSON.stringify({
    schema_version: 2,
    complete: true,
    generated_at: "2026-09-11T12:00:00.000Z",
    at: "2026-09-11T12:00:00.000Z",
    resolver_version: resolverVersion,
    conditions,
  });
