import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoundCondition,
  type BoundSpan,
  conditionsToEdges,
  edgeKey,
  parseConditionsJson,
  spanKey,
} from "../jobs/traffic/conditions-to-edges.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";
import {
  boundCondition,
  conditionRow,
  conditionsBody,
  effect,
  speedLimit,
} from "./fixtures/road-condition.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const W2E = new Map<number, WayEdge[]>([
  [
    10,
    [
      { forward: true, level: 0, tile: 1, index: 5 },
      { forward: false, level: 0, tile: 1, index: 6 },
      { forward: true, level: 0, tile: 1, index: 7 },
    ],
  ],
  [11, [{ forward: true, level: 0, tile: 1, index: 8 }]],
]);

const GEOM: [number, number][] = [
  [6.803, 51.2],
  [6.81, 51.2],
];

const SPAN: BoundSpan = { wayId: 10, dir: "f", startFraction: 0, endFraction: 1, geometry: GEOM };

/** A full closure of way 10 forward, as situation `recordId`. */
function cond(over: Partial<BoundCondition> = {}, fx = effect(), recordId = "a:1"): BoundCondition {
  return boundCondition({ segments: [SPAN], ...over }, fx, recordId);
}

describe("parseConditionsJson", () => {
  it("parses a v2 row into one bound effect", () => {
    const out = parseConditionsJson(
      conditionsBody([conditionRow("a:1", { startFraction: 0.3, geometry: GEOM })], "2.0.0"),
    );
    expect(out.resolverVersion).toBe("2.0.0");
    expect(out.conditions).toHaveLength(1);
    const c = out.conditions[0];
    expect(c).toMatchObject({
      id: "a:1#closure",
      recordId: "a:1",
      source: "fr",
      origin: "feed",
      routingEligible: true,
      bindingStatus: "exact",
      effect: { id: "closure", kind: "closure", scope: "road" },
    });
    expect(c?.segments[0]).toEqual({
      wayId: 10,
      dir: "f",
      startFraction: 0.3,
      endFraction: 1,
      geometry: GEOM,
    });
  });

  it("rejects malformed evidence and disagreement with projected spans atomically", () => {
    const parse = (evidence: Record<string, unknown>) =>
      parseConditionsJson(
        conditionsBody([conditionRow("a:1"), conditionRow("a:2", { evidence: evidence as never })]),
      );
    expect(() => parse({ segments: [null] })).toThrow();
    expect(() => parse({ fresh_until: "yesterday" })).toThrow();
    expect(() => parse({ schema_version: 1 })).toThrow("Invalid routing evidence");
    expect(() =>
      parse({
        segments: [{ segment_id: "10:f", direction: "reverse", from_fraction: 0, to_fraction: 1 }],
      }),
    ).toThrow("disagrees");
    expect(() => parse({ binding_status: "likely" })).toThrow("disagrees");
  });

  it("rejects a row whose identity, effect and evidence do not name the same effect", () => {
    const parse = (row: Record<string, unknown>) => () =>
      parseConditionsJson(conditionsBody([row]));
    expect(parse(conditionRow("a:1", { overrides: { id: "a:1" } }))).toThrow("identity");
    expect(parse(conditionRow("a:1", { evidence: { record_id: "a:2" } }))).toThrow(
      "another effect",
    );
    expect(parse(conditionRow("a:1", { evidence: { effect_id: "other" } }))).toThrow(
      "another effect",
    );
    expect(
      parse(conditionRow("a:1", { overrides: { effect: { ...effect("closure"), id: "other" } } })),
    ).toThrow("Invalid condition effect");
    expect(parse(conditionRow("a:1", { overrides: { routing_evidence: undefined } }))).toThrow(
      "Invalid routing evidence",
    );
  });

  it("keeps an effect it cannot read as unsupported restriction evidence", () => {
    const future = { ...effect("closure"), kind: "teleport" };
    const out = parseConditionsJson(
      conditionsBody([conditionRow("a:1", { overrides: { effect: future } })]),
    );
    expect(out.conditions[0]?.effect).toMatchObject({
      id: "closure",
      kind: "unsupported",
      normalization: "unsupported",
    });
    expect(conditionsToEdges(out.conditions, W2E).overrides.size).toBe(0);
  });

  it("keeps a point-bound span whose fractions are equal", () => {
    const row = conditionRow("p:1", {
      evidence: {
        segments: [
          { segment_id: "10:b", direction: "reverse", from_fraction: 0.42, to_fraction: 0.42 },
        ],
        binding_status: "likely",
      },
      overrides: {
        binding: { status: "likely" },
        segments: [
          {
            way_id: 10,
            dir: "b",
            start_fraction: 0.42,
            end_fraction: 0.42,
            geometry: { type: "LineString", coordinates: GEOM },
          },
        ],
      },
    });
    const out = parseConditionsJson(conditionsBody([row]));
    expect(out.conditions[0]?.segments[0]).toEqual({
      wayId: 10,
      dir: "b",
      startFraction: 0.42,
      endFraction: 0.42,
      geometry: GEOM,
    });
  });

  it("rejects a line with a non-numeric coordinate instead of coercing it", () => {
    const row = conditionRow("a:1", {
      geometry: [
        [null as unknown as number, 51.2],
        [6.81, 51.2],
      ],
    });
    expect(() => parseConditionsJson(conditionsBody([row]))).toThrow("Invalid condition spans");
  });

  it("treats a row without a known origin as crowd, so it needs routing_eligible to apply", () => {
    const row = (extra: Record<string, unknown>) =>
      conditionRow("no-origin", { overrides: { origin: undefined, ...extra } });

    const gated = parseConditionsJson(conditionsBody([row({ routing_eligible: false })]));
    expect(gated.conditions[0]?.origin).toBe("crowd");
    const gatedResult = conditionsToEdges(gated.conditions, W2E);
    expect(gatedResult.overrides.size).toBe(0);
    expect(gatedResult.skipped.crowdNotEligible).toBe(1);

    const eligible = parseConditionsJson(conditionsBody([row({ routing_eligible: true })]));
    const eligibleResult = conditionsToEdges(eligible.conditions, W2E);
    expect(eligibleResult.skipped.crowdNotEligible).toBe(0);
    expect(eligibleResult.appliedObservationIds).toEqual(new Set(["no-origin#closure"]));
  });

  it.each([
    {},
    { conditions: {} },
    { schema_version: 2, complete: true, conditions: [null] },
    { schema_version: 2, complete: false, conditions: [] },
    { schema_version: 2, conditions: [] },
    { schema_version: 1, complete: true, conditions: [] },
    { complete: true, conditions: [] },
  ])("rejects a malformed, partial or other-version snapshot %j", (payload) => {
    expect(() => parseConditionsJson(JSON.stringify(payload))).toThrow();
  });
});

describe("conditionsToEdges", () => {
  it("uses a proven full-way mapping and records its complete effect", () => {
    const r = conditionsToEdges([cond()], W2E);
    expect([...r.overrides.keys()].sort()).toEqual(["0:1:5", "0:1:7"]);
    expect(r.overrides.get("0:1:5")).toMatchObject({
      closed: true,
      observationId: "a:1#fr1/closure",
    });
    expect(r.appliedObservationIds).toEqual(new Set(["a:1#fr1/closure"]));
    expect(r.wholeWaySpans).toBe(1);
    expect(r.edgeExactSpans).toBe(0);
  });
  it("with resolved edges, closes only the traced subset", () => {
    const c = cond();
    const resolved = new Map([
      [spanKey(c.id, SPAN), [{ forward: true, level: 0, tile: 1, index: 7 }]],
    ]);
    const r = conditionsToEdges([c], W2E, resolved);
    expect([...r.overrides.keys()]).toEqual(["0:1:7"]);
    expect(r.edgeExactSpans).toBe(1);
    expect(r.wholeWaySpans).toBe(0);
    expect(r.appliedObservationIds).toEqual(new Set([c.id]));
  });
  it("uses the backward edge for dir b", () => {
    const c = cond({
      segments: [{ wayId: 10, dir: "b", startFraction: 0, endFraction: 1, geometry: null }],
    });
    c.routingEvidence.segments = [
      { segment_id: "10:b", direction: "reverse", from_fraction: 0, to_fraction: 1 },
    ];
    expect([...conditionsToEdges([c], W2E).overrides.keys()]).toEqual(["0:1:6"]);
  });
  it("spanKey changes with geometry, condition id and fractions", () => {
    const s = SPAN;
    expect(spanKey("a:1", s)).not.toBe(spanKey("a:2", s));
    expect(spanKey("a:1#x", s)).not.toBe(spanKey("a:1#y", s));
    expect(spanKey("a:1", s)).not.toBe(spanKey("a:1", { ...s, geometry: null }));
    expect(spanKey("a:1", s)).not.toBe(spanKey("a:1", { ...s, endFraction: 0.9 }));
    expect(spanKey("a:1", s)).toBe(spanKey("a:1", { ...s, geometry: [...GEOM] }));
  });
  it("spanKey separates two null-geometry spans of one condition on the same directed way", () => {
    const a: BoundSpan = {
      wayId: 10,
      dir: "f",
      startFraction: 0,
      endFraction: 0.4,
      geometry: null,
    };
    const b: BoundSpan = { ...a, startFraction: 0.6, endFraction: 1 };
    expect(spanKey("a:1", a)).not.toBe(spanKey("a:1", b));
  });
  it("writes a speed cap for a mandatory limit and never marks it applied", () => {
    const r = conditionsToEdges([cond({}, speedLimit(60), "rw")], W2E);
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: false, capKph: 60 });
    expect(r.appliedObservationIds.size).toBe(0);
  });
  it("closure beats cap on the same edge", () => {
    const r = conditionsToEdges([cond({}, speedLimit(60), "rw"), cond()], W2E);
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: true });
  });
  it("applies each effect of one situation on its own spans", () => {
    const r = conditionsToEdges(
      [cond(), cond({ segments: [{ ...SPAN, wayId: 11, geometry: null }] }, speedLimit(30))],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({
      closed: true,
      observationId: "a:1#fr1/closure",
    });
    expect(r.overrides.get("0:1:8")).toMatchObject({
      closed: false,
      capKph: 30,
      observationId: "a:1#fr1/speed_limit",
    });
    expect(r.appliedObservationIds).toEqual(new Set(["a:1#fr1/closure"]));
  });
  it("closes the road for every lane closed", () => {
    const r = conditionsToEdges(
      [cond({}, effect("fr1/lanes", "lane_restriction", { vehicleImpact: "all_lanes_closed" }))],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: true });
  });
  it("skips ambiguous bindings, non-eligible crowd rows, lorry closures and effects cars ignore", () => {
    const r = conditionsToEdges(
      [
        cond({ bindingStatus: "ambiguous" }, effect(), "amb"),
        cond({ origin: "crowd", routingEligible: false }, effect(), "crowd"),
        cond(
          {},
          effect("fr1/closure", "closure", {
            applicability: { kind: "classes", include: [{ class: "truck" }] },
          }),
          "truck",
        ),
        cond({}, effect("fr1/delay", "delay"), "delay"),
        cond(
          {},
          effect("fr1/speed_limit", "speed_limit", {
            limit: { value: 60, unit: "km/h" },
            advisory: true,
          }),
          "advisory",
        ),
        cond({}, effect("fr1/closure", "closure", { normalization: "partial" }), "partial"),
      ],
      W2E,
    );
    expect(r.overrides.size).toBe(0);
    expect(r.skipped).toEqual({ notRelevant: 1, crowdNotEligible: 1, noEffect: 4 });
  });
  it("reports ways missing from the map", () => {
    const r = conditionsToEdges(
      [
        cond({
          segments: [{ wayId: 999, dir: "f", startFraction: 0, endFraction: 1, geometry: null }],
        }),
      ],
      W2E,
    );
    expect(r.missingWayIds).toEqual(new Set([999]));
    expect(r.appliedObservationIds.size).toBe(0);
  });
  it("keeps the lower cap when two limits hit the same edge", () => {
    const r = conditionsToEdges(
      [cond({}, speedLimit(40), "rw40"), cond({}, speedLimit(60), "rw60")],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({
      closed: false,
      capKph: 40,
      observationId: "rw40#fr1/speed_limit",
    });
  });
  it("applies a crowd row that is marked routing eligible", () => {
    const r = conditionsToEdges(
      [cond({ origin: "crowd", routingEligible: true }, effect(), "crowd")],
      W2E,
    );
    expect(r.appliedObservationIds).toEqual(new Set(["crowd#fr1/closure"]));
    expect(r.skipped.crowdNotEligible).toBe(0);
  });
  it("edgeKey is stable", () => {
    expect(edgeKey({ level: 0, tile: 1, index: 5 })).toBe("0:1:5");
  });
});

describe("versioned road condition safety", () => {
  it("does not widen a failed partial trace to a whole way", () => {
    const result = conditionsToEdges(
      [cond({ segments: [{ ...SPAN, startFraction: 0.3 }] })],
      W2E,
      undefined,
      { evaluatedAt: Date.parse("2026-09-11T12:00:00Z") },
    );
    expect(result.overrides.size).toBe(0);
  });
  it("withholds the whole effect if any intended span is absent", () => {
    const c = cond({
      segments: [
        { ...SPAN, startFraction: 0 },
        { ...SPAN, wayId: 999 },
      ],
    });
    expect(
      conditionsToEdges([c], W2E, undefined, { evaluatedAt: Date.parse("2026-09-11T12:00:00Z") })
        .overrides.size,
    ).toBe(0);
  });
  it("does not apply expired, obsolete or mismatched evidence", () => {
    expect(
      conditionsToEdges([cond()], W2E, undefined, {
        evaluatedAt: Date.parse("2026-09-11T12:10:00Z"),
      }).overrides.size,
    ).toBe(0);
    const obsolete = cond();
    obsolete.routingEvidence = { ...obsolete.routingEvidence, binding_revision: 2 };
    expect(conditionsToEdges([obsolete], W2E).overrides.size).toBe(0);
    const otherKind = cond({}, speedLimit(30));
    otherKind.routingEvidence = { ...otherKind.routingEvidence, effect_kind: "closure" };
    expect(conditionsToEdges([otherKind], W2E).overrides.size).toBe(0);
  });
  it("does not route an effect outside its own validity window", () => {
    const c = cond();
    c.routingEvidence = {
      ...c.routingEvidence,
      valid_from: "2026-09-11T13:00:00Z",
      valid_to: "2026-09-11T14:00:00Z",
    };
    expect(conditionsToEdges([c], W2E).overrides.size).toBe(0);
  });
  it("does not route a recurring effect without a published next transition", () => {
    const nightly = effect("fr1/closure", "closure", {
      validity: {
        status: "active",
        periods: [{ startTime: "20:00", duration: "PT9H", scheduleTimezone: "Europe/Paris" }],
      },
    });
    expect(conditionsToEdges([cond({}, nightly)], W2E).overrides.size).toBe(0);
    const announced = cond({}, nightly);
    announced.routingEvidence = {
      ...announced.routingEvidence,
      next_transition_at: "2026-09-11T12:05:00Z",
    };
    expect(conditionsToEdges([announced], W2E).overrides.size).toBe(2);
  });
});
