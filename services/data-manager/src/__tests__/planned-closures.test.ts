import { haversineDistance, type LngLat } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundCondition, BoundSpan } from "../jobs/traffic/conditions-to-edges.js";
import { plannedClosures, sampleSpan } from "../jobs/traffic/planned-closures.js";
import { boundCondition, effect, evidence } from "./fixtures/road-condition.js";

const NOW = Date.parse("2026-09-11T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** About 250 m of road due north from 51.2 N, 6.8 E. */
const NORTH: LngLat[] = [
  [6.8, 51.2],
  [6.8, 51.20225],
];
const BOX = [6.7, 51.1, 6.9, 51.3] as const;

function closure(
  over: Partial<BoundCondition> = {},
  fx = effect(),
  geometry: LngLat[] | null = NORTH,
): BoundCondition {
  const span: BoundSpan = { wayId: 10, dir: "f", startFraction: 0, endFraction: 1, geometry };
  return boundCondition({ segments: [span], ...over }, fx);
}

const plan = (conditions: BoundCondition[], travelAt = NOW + 3_600_000) =>
  plannedClosures(conditions, { bbox: BOX, travelAt, evaluatedAt: NOW });

describe("sampleSpan", () => {
  it("spaces samples at most 100 m apart, clear of both ends, in travel direction", () => {
    const samples = sampleSpan(NORTH);
    expect(samples.length).toBe(4);
    const along = samples.map((s) => haversineDistance(NORTH[0]!, [s.lon, s.lat]));
    expect(along[0]).toBeCloseTo(15, 0);
    expect(along.at(-1)).toBeCloseTo(haversineDistance(NORTH[0]!, NORTH[1]!) - 15, 0);
    for (let i = 1; i < along.length; i++)
      expect(along[i]! - along[i - 1]!).toBeLessThanOrEqual(100);
    expect(samples.every((s) => s.heading === 0)).toBe(true);
    const south = sampleSpan([...NORTH].reverse());
    expect(south.every((s) => s.heading === 180)).toBe(true);
  });

  it("puts one sample in the middle of a span too short for both margins", () => {
    const short: LngLat[] = [
      [6.8, 51.2],
      [6.8, 51.2001],
    ];
    const [only, ...rest] = sampleSpan(short);
    expect(rest).toEqual([]);
    expect(only?.lat).toBeCloseTo(51.20005, 6);
  });

  it("never takes a heading from a zero-length segment", () => {
    expect(sampleSpan([NORTH[0]!, NORTH[0]!])).toEqual([]);
  });
});

describe("plannedClosures", () => {
  it("returns a bound feed closure in force at the travel instant", () => {
    const { closures, unrepresentable } = plan([closure()]);
    expect(unrepresentable).toBe(0);
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({
      id: "oc:situation:fr:1#fr1/closure",
      source: "fr",
      localAccess: false,
      validUntil: "2026-09-11T12:10:00.000Z",
    });
    expect(closures[0]?.samples.length).toBe(4);
  });

  it("leaves out a closure whose window has not begun or has ended at the travel instant", () => {
    const later = closure();
    later.routingEvidence = evidence({ valid_from: "2026-09-12T00:00:00Z" });
    const ended = closure();
    ended.routingEvidence = evidence({ valid_to: "2026-09-11T12:30:00Z" });
    expect(plan([later, ended]).closures).toEqual([]);
    expect(plan([later], Date.parse("2026-09-12T08:00:00Z")).closures).toHaveLength(1);
  });

  it("evaluates an effect's recurring periods at the travel instant", () => {
    const nightly = closure(
      {},
      effect("fr1/closure", "closure", {
        validity: {
          status: "active",
          periods: [
            {
              startTime: "22:00",
              duration: "PT7H",
              repeatFrequency: "P1D",
              scheduleTimezone: "Europe/Paris",
            },
          ],
        },
      }),
    );
    nightly.routingEvidence = evidence({ next_transition_at: "2026-09-11T20:00:00Z" });
    expect(plan([nightly], Date.parse("2026-09-11T14:00:00Z")).closures).toEqual([]);
    expect(plan([nightly], Date.parse("2026-09-11T23:00:00Z")).closures).toHaveLength(1);
  });

  it("leaves out what a car's route may still use or must not rely on", () => {
    const conditions = [
      closure({ bindingStatus: "ambiguous" }),
      closure({}, effect("fr1/lanes", "lane_restriction", { vehicleImpact: "one_lane_closed" })),
      closure({ origin: "crowd", routingEligible: false }),
    ];
    conditions[1]!.routingEvidence = evidence({
      effect_id: "fr1/lanes",
      effect_kind: "lane_restriction",
    });
    expect(plan(conditions).closures).toEqual([]);
  });

  it("refuses a closure without reviewed rights", () => {
    const unreviewed = closure();
    unreviewed.routingEvidence = evidence({
      rights: { ...evidence().rights, reviewed_at: null },
    });
    expect(plan([unreviewed]).closures).toEqual([]);
  });

  it("refuses a disallowed source", () => {
    const { closures } = plannedClosures([closure()], {
      bbox: BOX,
      travelAt: NOW + 3_600_000,
      evaluatedAt: NOW,
      disallowedSources: new Set(["fr"]),
    });
    expect(closures).toEqual([]);
  });

  it("keeps only closures with a sample in the box and counts those without geometry", () => {
    const elsewhere = closure({}, effect(), [
      [9.0, 48.0],
      [9.0, 48.003],
    ]);
    const { closures, unrepresentable } = plan([elsewhere, closure({}, effect(), null)]);
    expect(closures).toEqual([]);
    expect(unrepresentable).toBe(1);
  });

  it("flags a closure open to local access", () => {
    const local = closure(
      {},
      effect("fr1/closure", "closure", {
        applicability: { kind: "all", except: [{ usage: "residents" }] },
      }),
    );
    const { closures } = plan([local]);
    expect(closures[0]?.localAccess).toBe(true);
  });
});
