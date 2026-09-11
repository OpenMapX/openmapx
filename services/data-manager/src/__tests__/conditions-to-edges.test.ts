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
import { event } from "./fixtures/road-condition.js";

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

function cond(over: Partial<BoundCondition> = {}): BoundCondition {
  return {
    source: "fr",
    routingEvidence: event().routingEvidence,
    id: "a:1",
    type: "road_closure",
    roadState: "closed",
    speedLimitKph: null,
    vehiclesAffected: [],
    originKind: "feed",
    routingEligible: true,
    bindingStatus: "exact",
    segments: [SPAN],
    ...over,
  };
}

describe("parseConditionsJson", () => {
  it("rejects malformed evidence and disagreement with projected spans atomically", () => {
    const row = {
      id: "a:1",
      type: "road_closure",
      binding: { status: "exact" },
      routing_evidence: event().routingEvidence,
      segments: [
        {
          way_id: 10,
          dir: "f",
          start_fraction: 0,
          end_fraction: 1,
          geometry: { type: "LineString", coordinates: GEOM },
        },
      ],
    };
    const parse = (routing_evidence: unknown) =>
      parseConditionsJson(
        JSON.stringify({
          schema_version: 1,
          complete: true,
          conditions: [{ ...row, routing_evidence }],
        }),
      );
    expect(() => parse({ ...row.routing_evidence, segments: [null] })).toThrow();
    expect(() => parse({ ...row.routing_evidence, fresh_until: "yesterday" })).toThrow();
    expect(() =>
      parse({
        ...row.routing_evidence,
        segments: [{ segment_id: "10", direction: "reverse", from_fraction: 0, to_fraction: 1 }],
      }),
    ).toThrow();
  });

  it("parses valid snake_case rows into BoundCondition", () => {
    const body = JSON.stringify({
      resolver_version: "1.0.0",
      conditions: [
        {
          id: "a:1",
          type: "road_closure",
          road_state: "closed",
          speed_limit_kph: null,
          vehicles_affected: [],
          origin_kind: "feed",
          routing_eligible: true,
          binding: { status: "exact" },
          segments: [
            {
              way_id: 10,
              dir: "f",
              start_fraction: 0.3,
              end_fraction: 1,
              geometry: { type: "LineString", coordinates: GEOM },
            },
            { way_id: 11, dir: "f", start_fraction: 0, end_fraction: 1, geometry: null },
          ],
        },
      ],
    });
    const out = parseConditionsJson(body);
    expect(out.resolverVersion).toBe("1.0.0");
    expect(out.conditions).toHaveLength(1);
    expect(out.conditions[0]?.segments[0]).toEqual({
      wayId: 10,
      dir: "f",
      startFraction: 0.3,
      endFraction: 1,
      geometry: GEOM,
    });
    expect(out.conditions[0]?.segments[1]?.geometry).toBeNull();
  });

  it("keeps a point-bound span whose fractions are equal", () => {
    const body = JSON.stringify({
      conditions: [
        {
          id: "p:1",
          type: "accident",
          road_state: "closed",
          binding: { status: "likely" },
          origin_kind: "feed",
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
      ],
    });
    const out = parseConditionsJson(body);
    expect(out.resolverVersion).toBeNull();
    expect(out.conditions[0]?.segments[0]).toEqual({
      wayId: 10,
      dir: "b",
      startFraction: 0.42,
      endFraction: 0.42,
      geometry: GEOM,
    });
  });

  it("rejects a line with a non-numeric coordinate instead of coercing it", () => {
    const body = JSON.stringify({
      conditions: [
        {
          id: "a:1",
          type: "road_closure",
          road_state: "closed",
          origin_kind: "feed",
          binding: { status: "exact" },
          segments: [
            {
              way_id: 10,
              dir: "f",
              start_fraction: 0,
              end_fraction: 1,
              geometry: {
                type: "LineString",
                coordinates: [
                  [null, 51.2],
                  [6.81, 51.2],
                ],
              },
            },
          ],
        },
      ],
    });
    expect(() => parseConditionsJson(body)).toThrow("Invalid condition spans");
  });

  it("treats a row without origin_kind as crowd, so it needs routing_eligible to apply", () => {
    function row(extra: Record<string, unknown>) {
      return {
        id: "no-origin",
        type: "road_closure",
        road_state: "closed",
        binding: { status: "exact" },
        segments: [{ way_id: 10, dir: "f", start_fraction: 0, end_fraction: 1, geometry: null }],
        ...extra,
      };
    }

    const gated = parseConditionsJson(JSON.stringify({ conditions: [row({})] }));
    expect(gated.conditions[0]?.originKind).toBe("crowd");
    const gatedResult = conditionsToEdges(gated.conditions, W2E);
    expect(gatedResult.overrides.size).toBe(0);
    expect(gatedResult.skipped.crowdNotEligible).toBe(1);

    const eligible = parseConditionsJson(
      JSON.stringify({ conditions: [row({ routing_eligible: true })] }),
    );
    const eligibleResult = conditionsToEdges(eligible.conditions, W2E);
    expect(eligibleResult.appliedObservationIds.size).toBe(0);
    expect(eligibleResult.skipped.crowdNotEligible).toBe(0);
  });

  it("rejects a payload without a conditions array", () => {
    expect(() => parseConditionsJson(JSON.stringify({ resolver_version: 3 }))).toThrow();
  });
});

describe("conditionsToEdges", () => {
  it("uses a proven full-way mapping and records its complete effect", () => {
    const r = conditionsToEdges([cond()], W2E);
    expect([...r.overrides.keys()].sort()).toEqual(["0:1:5", "0:1:7"]);
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: true, observationId: "a:1" });
    expect(r.appliedObservationIds).toEqual(new Set(["a:1"]));
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
    expect(r.appliedObservationIds).toEqual(new Set(["a:1"]));
  });
  it("uses the backward edge for dir b", () => {
    const r = conditionsToEdges(
      [
        cond({
          segments: [{ wayId: 10, dir: "b", startFraction: 0, endFraction: 1, geometry: null }],
        }),
      ],
      W2E,
    );
    expect([...r.overrides.keys()]).toEqual(["0:1:6"]);
  });
  it("spanKey changes with geometry, observation id and fractions", () => {
    const s = SPAN;
    expect(spanKey("a:1", s)).not.toBe(spanKey("a:2", s));
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
  it("writes a speed cap for roadworks with a limit and never marks it applied", () => {
    const r = conditionsToEdges(
      [cond({ id: "rw", type: "roadworks", roadState: "some_lanes_closed", speedLimitKph: 60 })],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: false, capKph: 60 });
    expect(r.appliedObservationIds.size).toBe(0);
  });
  it("closure beats cap on the same edge", () => {
    const r = conditionsToEdges(
      [
        cond({ id: "rw", type: "roadworks", roadState: "some_lanes_closed", speedLimitKph: 60 }),
        cond(),
      ],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({ closed: true });
  });
  it("skips ambiguous bindings, non-eligible crowd rows, truck-only closures, and no-effect rows", () => {
    const r = conditionsToEdges(
      [
        cond({ id: "amb", bindingStatus: "ambiguous" }),
        cond({ id: "crowd", originKind: "crowd", routingEligible: false }),
        cond({ id: "truck", vehiclesAffected: ["truck"] }),
        cond({ id: "acc", type: "accident", roadState: null }),
      ],
      W2E,
    );
    expect(r.overrides.size).toBe(0);
    expect(r.skipped).toEqual({ notRelevant: 1, crowdNotEligible: 1, noEffect: 2 });
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
      [
        cond({ id: "rw40", type: "roadworks", roadState: "some_lanes_closed", speedLimitKph: 40 }),
        cond({ id: "rw60", type: "roadworks", roadState: "some_lanes_closed", speedLimitKph: 60 }),
      ],
      W2E,
    );
    expect(r.overrides.get("0:1:5")).toMatchObject({
      closed: false,
      capKph: 40,
      observationId: "rw40",
    });
  });
  it("applies a crowd row that is marked routing eligible", () => {
    const r = conditionsToEdges(
      [cond({ id: "crowd", originKind: "crowd", routingEligible: true })],
      W2E,
    );
    expect(r.appliedObservationIds).toEqual(new Set(["crowd"]));
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
  it("withholds the whole event if any intended span is absent", () => {
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
  it("does not apply legacy or expired evidence", () => {
    expect(conditionsToEdges([cond({ routingEvidence: undefined })], W2E).overrides.size).toBe(0);
    expect(
      conditionsToEdges([cond()], W2E, undefined, {
        evaluatedAt: Date.parse("2026-09-11T12:10:00Z"),
      }).overrides.size,
    ).toBe(0);
  });
  it.each([
    {},
    { conditions: {} },
    { conditions: [null] },
    { schema_version: 1, complete: false, conditions: [] },
  ])("rejects a malformed or partial snapshot %j", (payload) => {
    expect(() => parseConditionsJson(JSON.stringify(payload))).toThrow();
  });
});
