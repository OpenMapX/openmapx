import { assert, describe, expect, it } from "vitest";
import type { ManeuverLane } from "../../types/routing";
import {
  guidanceApproachMeters,
  guidanceLanesForStep,
  narrowForNextManeuver,
  resolveGuidanceLanes,
  resolveLaneGuidance,
  resolveRecommendedLanes,
  shouldPreviewNextStep,
} from "../lanes";

const lane = (indications: string[], valid = false): ManeuverLane => ({ indications, valid });

describe("resolveRecommendedLanes", () => {
  it("does not turn unknown arrows into an invented recommendation", () => {
    const result = resolveLaneGuidance([{ indications: ["left"] }, { indications: ["through"] }]);
    expect(result.state).toBe("unknown");
    expect(result.usableLanes).toEqual([]);
    expect(result.preferredLanes).toEqual([]);
  });
  it("keeps initially usable and preferred sets distinct", () => {
    const result = resolveLaneGuidance([
      { indications: ["left"], valid: true, preferred: false },
      { indications: ["left"], valid: true, preferred: true },
      { indications: ["right"], valid: false, preferred: false },
    ]);
    expect(result.usableLanes).toEqual([0, 1]);
    expect(result.preferredLanes).toEqual([1]);
    expect(result.state).toBe("known");
  });
  it("preserves explicit engine rejection instead of guessing from turn arrows", () => {
    const lanes = [lane(["left"], false), lane(["through"], false), lane(["right"], false)];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([false, false, false]);
    const [first] = out;
    assert.isDefined(first);
    expect(first.active).toBeUndefined();
  });
  it("trusts the engine when a lane is already valid", () => {
    const lanes = [lane(["left"], true), lane(["through"])];
    expect(resolveRecommendedLanes(lanes, { type: "turn", modifier: "right" })).toBe(lanes);
  });

  it("does not infer branch identity from the same side", () => {
    const lanes = [lane(["slight left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "left" });
    expect(out[0]?.valid).toBe(false);
  });

  it("retains rejected through lanes for a straight maneuver", () => {
    const lanes = [lane(["left"]), lane(["through"])];
    const out = resolveRecommendedLanes(lanes, { type: "turn", modifier: "straight" });
    expect(out.map((l) => l.valid)).toEqual([false, false]);
  });

  it("returns [] for no lanes", () => {
    expect(resolveRecommendedLanes(undefined, { type: "turn", modifier: "left" })).toEqual([]);
  });

  it("does not invent through recommendations for a keep maneuver", () => {
    const lanes = [lane(["through"]), lane(["through"]), lane(["slight_right"])];
    const out = resolveRecommendedLanes(lanes, { type: "keep", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([false, false, false]);
  });
});

const unknownLane = (indications: string[], valid?: boolean): ManeuverLane => ({
  indications,
  valid,
});

describe("resolveGuidanceLanes", () => {
  // Kreuz Aachen, the 4-lane link toward A 44: every lane `through`, the left
  // two signed Düsseldorf and the right two Liège, all four "A 44".
  const kreuzAachen = [
    unknownLane(["through"]),
    unknownLane(["through"]),
    unknownLane(["through"]),
    unknownLane(["through"]),
  ];
  const keepLeft = { type: "keep", modifier: "left" };
  const toDuesseldorf = { exitBranches: ["A 44"], exitToward: ["Düsseldorf"] };
  const splitDestinations = [
    { destinations: ["Düsseldorf"], refs: ["A 44"] },
    { destinations: ["Düsseldorf"], refs: ["A 44"] },
    { destinations: ["Liège"], refs: ["A 44"] },
    { destinations: ["Liège"], refs: ["A 44"] },
  ];

  it("highlights no lane when every through lane would light up for a keep left", () => {
    const out = resolveGuidanceLanes(kreuzAachen, keepLeft);
    expect(out.map((l) => l.valid)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("highlights the lanes whose OSM destinations name the sign", () => {
    const out = resolveGuidanceLanes(kreuzAachen, keepLeft, {
      sign: toDuesseldorf,
      laneDestinations: splitDestinations,
    });
    expect(out.map((l) => l.valid)).toEqual([true, true, false, false]);
  });

  it("falls back to refs when the places do not tell the lanes apart", () => {
    const out = resolveGuidanceLanes(
      [unknownLane(["through"]), unknownLane(["through"]), unknownLane(["through"])],
      { type: "keep", modifier: "right" },
      {
        sign: { exitBranches: ["A44"], exitToward: ["Köln"] },
        laneDestinations: [
          { destinations: ["Köln"], refs: ["A 4"] },
          { destinations: ["Köln"], refs: ["A 44"] },
          { destinations: ["Köln"], refs: ["A 44"] },
        ],
      },
    );
    expect(out.map((l) => l.valid)).toEqual([false, true, true]);
  });

  it("ignores lane destinations that do not line up with the engine's lanes", () => {
    const out = resolveGuidanceLanes(kreuzAachen, keepLeft, {
      sign: toDuesseldorf,
      laneDestinations: splitDestinations.slice(0, 3),
    });
    expect(out.map((l) => l.valid)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("still trusts the engine over the lane destinations", () => {
    const lanes = [
      unknownLane(["through"]),
      unknownLane(["through"]),
      unknownLane(["through"]),
      unknownLane(["through"], true),
    ];
    const out = resolveGuidanceLanes(lanes, keepLeft, {
      sign: toDuesseldorf,
      laneDestinations: splitDestinations,
    });
    expect(out).toBe(lanes);
  });

  it("does not infer routed lanes from through arrows before a keep-left", () => {
    const lanes = [
      unknownLane(["through"]),
      unknownLane(["through"]),
      unknownLane(["slight_right"]),
    ];
    const out = resolveGuidanceLanes(lanes, keepLeft);
    expect(out.map((l) => l.valid)).toEqual([undefined, undefined, undefined]);
  });

  it("keeps unknown lane selection even when both arrows turn the maneuver's way", () => {
    const lanes = [unknownLane(["left"]), unknownLane(["left", "through"])];
    const out = resolveGuidanceLanes(lanes, { type: "turn", modifier: "left" });
    expect(out.map((l) => l.valid)).toEqual([undefined, undefined]);
  });

  it("does not infer lane selection for a straight maneuver", () => {
    const out = resolveGuidanceLanes([unknownLane(["through"]), unknownLane(["through"])], {
      type: "continue",
      modifier: "straight",
    });
    expect(out.map((l) => l.valid)).toEqual([undefined, undefined]);
  });
});

describe("guidanceApproachMeters", () => {
  it("floors at the minimum distance when stopped or slow", () => {
    expect(guidanceApproachMeters("driving", 0)).toBe(300);
    expect(guidanceApproachMeters("driving", 5)).toBe(300);
  });

  it("gives roughly the city lead time around reference speed", () => {
    // 35 s lead at ~50 km/h → 14 m/s × 35 s.
    expect(guidanceApproachMeters("driving", 14)).toBe(490);
  });

  it("stretches the lead TIME on the motorway, not just distance", () => {
    // 90 s lead at ~120 km/h → 33 m/s × 90 s.
    expect(guidanceApproachMeters("driving", 33)).toBe(2970);
    // The implied lead time is far larger at motorway speed than in the city.
    const cityLead = guidanceApproachMeters("driving", 14) / 14;
    const autobahnLead = guidanceApproachMeters("driving", 33) / 33;
    expect(autobahnLead).toBeGreaterThan(cityLead * 2);
  });

  it("interpolates the lead between city and motorway speed", () => {
    expect(guidanceApproachMeters("driving", 25)).toBeCloseTo(1671, 0);
  });
});

describe("shouldPreviewNextStep", () => {
  it("hides the preview while the maneuver is still far off", () => {
    // 2000 m out at city speed is well beyond the ~490 m approach window.
    expect(shouldPreviewNextStep("driving", 14, 2000, 10)).toBe(false);
  });

  it("shows the preview when approaching and the next maneuver follows closely", () => {
    expect(shouldPreviewNextStep("driving", 14, 300, 15)).toBe(true);
  });

  it("hides the preview when the next maneuver is far after this one", () => {
    // Approaching, but the gap to the following maneuver is 90 s — not a chain.
    expect(shouldPreviewNextStep("driving", 14, 300, 90)).toBe(false);
  });

  it("falls back to a distance gap when the engine omits the next-step duration", () => {
    // 420 m = 30 s × 14 m/s reference.
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 200)).toBe(true);
    expect(shouldPreviewNextStep("driving", 14, 300, 0, 800)).toBe(false);
  });
});

it("keeps contradictory preferred/rejected lane evidence in conflict", () => {
  const result = resolveLaneGuidance([{ indications: ["through"], valid: false, preferred: true }]);
  expect(result.state).toBe("conflict");
  expect(result.preferredLanes).toEqual([]);
  expect(result.usableLanes).toEqual([]);
});

describe("signed destinations and explicit engine evidence", () => {
  it("does not replace explicitly rejected lanes with destination-derived advice", () => {
    const lanes = [
      { indications: ["through"], valid: false },
      { indications: ["through"], valid: false },
    ];
    expect(
      resolveGuidanceLanes(
        lanes,
        { type: "keep", modifier: "left" },
        {
          sign: { exitToward: ["Target"] },
          laneDestinations: [
            { destinations: ["Target"], refs: [] },
            { destinations: ["Other"], refs: [] },
          ],
        },
      ),
    ).toEqual(lanes);
  });
});

describe("narrowForNextManeuver", () => {
  const L = (
    indications: string[],
    valid: boolean,
    preferred?: boolean,
    active?: string,
  ): ManeuverLane => ({
    indications,
    valid,
    ...(preferred === undefined ? {} : { preferred }),
    ...(active ? { active } : {}),
  });
  // Three through lanes, all usable; the next junction turns right from the right lane.
  const current = [L(["through"], true), L(["through"], true), L(["through"], true)];
  const nextRight = [
    L(["through"], false),
    L(["through"], false),
    L(["right"], true, true, "right"),
  ];

  it("narrows to the right lanes before a close right turn", () => {
    const narrowed = narrowForNextManeuver(current, nextRight, 120, false, "right");
    expect(narrowed.map((l) => l.preferred)).toEqual([false, false, true]);
    expect(narrowed.every((l) => l.valid)).toBe(true);
  });

  it("keeps everything when the next turn is 250 m away in town", () => {
    expect(narrowForNextManeuver(current, nextRight, 250, false, "right")).toBe(current);
  });

  it("uses 400 m on motorway steps", () => {
    expect(narrowForNextManeuver(current, nextRight, 350, true, "right")).not.toBe(current);
    expect(narrowForNextManeuver(current, nextRight, 450, true, "right")).toBe(current);
  });

  it("does nothing when the next lanes straddle the middle", () => {
    const middle = [L(["left"], false), L(["through"], true, true, "through"), L(["right"], false)];
    expect(narrowForNextManeuver(current, middle, 100, false, "right")).toBe(current);
  });

  it("does nothing when side and modifier disagree", () => {
    expect(narrowForNextManeuver(current, nextRight, 100, false, "left")).toBe(current);
    expect(narrowForNextManeuver(current, nextRight, 100, false, "straight")).toBe(current);
  });

  it("never marks an invalid lane preferred", () => {
    const withInvalid = [L(["left"], true), L(["through"], true), L(["right"], false)];
    const narrowed = narrowForNextManeuver(withInvalid, nextRight, 100, false, "right");
    expect(narrowed[2]).toEqual(withInvalid[2]);
    expect(narrowed.map((l) => l.preferred)).toEqual([false, true, undefined]);
  });

  it("k is at least one", () => {
    const nextUsableOnly = [L(["through"], false), L(["through"], false), L(["right"], true)];
    const narrowed = narrowForNextManeuver(current, nextUsableOnly, 100, false, "right");
    expect(narrowed.filter((l) => l.preferred === true)).toHaveLength(1);
  });

  it("no lanes gives no change", () => {
    expect(narrowForNextManeuver([], nextRight, 100, false, "right")).toEqual([]);
    expect(narrowForNextManeuver(current, [], 100, false, "right")).toBe(current);
  });

  it("drops the active arrow of a narrowed-away lane", () => {
    const withActive = current.map((l) => ({ ...l, preferred: true, active: "through" }));
    const narrowed = narrowForNextManeuver(withActive, nextRight, 100, false, "right");
    expect(narrowed[0]).toEqual({
      indications: ["through"],
      valid: true,
      preferred: false,
      narrowed: true,
    });
    expect(narrowed[2]?.active).toBe("through");
  });
});

describe("guidanceLanesForStep", () => {
  it("narrows the upcoming lanes by the step after it", () => {
    const current: ManeuverLane[] = [
      { indications: ["through"], valid: true },
      { indications: ["through"], valid: true },
    ];
    const next: ManeuverLane[] = [
      { indications: ["through"], valid: false },
      { indications: ["right"], valid: true, preferred: true, active: "right" },
    ];
    const steps = [
      { distance: 500 },
      { distance: 150, lanes: current },
      { distance: 300, maneuver: { type: "turn", modifier: "right" }, lanes: next },
    ];
    expect(guidanceLanesForStep(steps, 1, current, next)?.map((l) => l.preferred)).toEqual([
      false,
      true,
    ]);
    expect(guidanceLanesForStep(steps, 1, undefined, next)).toBeUndefined();
  });
});
