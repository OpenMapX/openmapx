import { describe, expect, it } from "vitest";
import {
  laneArrowStemShift,
  laneIndicationIconName,
  maneuverIconName,
  presentGuidanceLanes,
  unmarkedLaneIconName,
} from "./guidanceIcons";

describe("guidance glyphs", () => {
  it("names the maneuver's arrow as the phone and car draw it", () => {
    expect(maneuverIconName({ type: "turn", modifier: "left" })).toBe("TurnLeft");
    expect(maneuverIconName({ type: "keep", modifier: "left" })).toBe("TurnSlightLeft");
    expect(maneuverIconName({ type: "fork", modifier: "right" })).toBe("TurnSlightRight");
    expect(maneuverIconName({ type: "roundabout", modifier: "left" })).toBe("RoundaboutLeft");
    expect(maneuverIconName({ type: "arrive" })).toBe("Flag");
    expect(maneuverIconName(undefined)).toBe("Straight");
  });

  it("covers both routing vocabularies for lane indications", () => {
    expect(laneIndicationIconName("through")).toBe("Straight");
    expect(laneIndicationIconName("slight_left")).toBe("TurnSlightLeft");
    expect(laneIndicationIconName("reverse")).toBe("UTurnLeft");
    expect(laneIndicationIconName("merge_to_left")).toBe("MergeType");
    expect(laneIndicationIconName("none")).toBeNull();
    expect(unmarkedLaneIconName({ type: "arrive" })).toBeNull();
  });
});

describe("presentGuidanceLanes", () => {
  it("lights the engine's lanes and their active arrow", () => {
    const cells = presentGuidanceLanes(
      [
        { indications: ["left"], valid: true, active: "left" },
        { indications: ["left", "straight"], valid: true, active: "left" },
        { indications: ["straight"], valid: false },
      ],
      { type: "turn", modifier: "left" },
    );
    expect(cells.map((c) => c.valid)).toEqual([true, true, false]);
    expect(cells[1]?.arrows.map((a) => [a.icon, a.active])).toEqual([
      ["TurnLeft", true],
      ["Straight", false],
    ]);
    // Stacked arrows share a stem; a lone arrow stays centred as drawn.
    expect(cells[1]?.arrows[0]?.stemShift).toBe(-1 / 6);
    expect(cells[0]?.arrows[0]?.stemShift).toBe(0);
  });

  it("gives an unmarked lane the engine chose the maneuver's own arrow", () => {
    const [cell] = presentGuidanceLanes([{ indications: ["none"], valid: true }], {
      type: "turn",
      modifier: "right",
    });
    expect(cell).toMatchObject({ inferred: true, arrows: [{ icon: "TurnRight", active: true }] });
  });
});

it("keeps unselected, unknown and non-directional unmarked lanes blank", () => {
  const notChosen = presentGuidanceLanes(
    [
      { indications: ["left"], valid: true },
      { indications: ["none"], valid: false },
    ],
    { type: "turn", modifier: "left" },
  );
  expect(notChosen[1]).toMatchObject({ valid: false, inferred: false, arrows: [] });
  const unknown = presentGuidanceLanes(
    [
      { indications: ["none"], valid: undefined },
      { indications: ["right"], valid: undefined },
    ],
    { type: "turn", modifier: "left" },
  );
  expect(unknown.map((lane) => lane.valid)).toEqual([false, false]);
  expect(unknown.map((lane) => lane.inferred)).toEqual([false, false]);
  expect(unknown[0]?.arrows).toEqual([]);
  const roundabout = presentGuidanceLanes([{ indications: ["none"], valid: true }], {
    type: "roundabout",
    modifier: "right",
  });
  expect(roundabout[0]).toMatchObject({ valid: true, inferred: false, arrows: [] });
});

it("covers remaining provider maneuver vocabulary at the shared owner", () => {
  const cases = [
    [{ type: "turn", modifier: "right" }, "TurnRight"],
    [{ type: "off ramp", modifier: "left" }, "TurnSlightLeft"],
    [{ type: "on ramp", modifier: "right" }, "TurnSlightRight"],
    [{ type: "off ramp", modifier: "slight right" }, "TurnSlightRight"],
    [{ type: "on ramp", modifier: "slight left" }, "TurnSlightLeft"],
    [{ type: "fork", modifier: "sharp left" }, "TurnSharpLeft"],
    [{ type: "fork", modifier: "straight" }, "Straight"],
    [{ type: "fork" }, "Straight"],
    [{ type: "roundabout" }, "RoundaboutRight"],
    [{ type: "rotary", modifier: "left" }, "RoundaboutLeft"],
    [{ type: "exit roundabout", modifier: "right" }, "RoundaboutRight"],
    [{ type: "exit rotary", modifier: "left" }, "RoundaboutLeft"],
    [{ type: "merge", modifier: "slight left" }, "MergeType"],
    [{ type: "keep", modifier: "right" }, "TurnSlightRight"],
    [{ type: "keep", modifier: "straight" }, "Straight"],
    [{ type: "end of road", modifier: "left" }, "TurnLeft"],
    [{ type: "continue", modifier: "slight right" }, "TurnSlightRight"],
    [{ type: "new name", modifier: "straight" }, "Straight"],
  ] as const;
  for (const [maneuver, expected] of cases) expect(maneuverIconName(maneuver)).toBe(expected);
});

it("aligns every measured Material arrow stem to the24-unit centerline", () => {
  const centers = [
    ["Straight", 12],
    ["TurnSlightLeft", 14],
    ["TurnSlightRight", 10],
    ["TurnLeft", 16],
    ["TurnRight", 8],
    ["TurnSharpLeft", 17],
    ["TurnSharpRight", 7],
    ["UTurnLeft", 17],
    ["MergeType", 12],
  ] as const;
  for (const [name, center] of centers)
    expect(laneArrowStemShift(name)).toBeCloseTo((12 - center) / 24);
});

it("covers remaining provider lane token spellings and unknown fallback", () => {
  const cases = [
    ["", null],
    ["left", "TurnLeft"],
    ["right", "TurnRight"],
    ["slight left", "TurnSlightLeft"],
    ["slight right", "TurnSlightRight"],
    ["sharp left", "TurnSharpLeft"],
    ["sharp right", "TurnSharpRight"],
    ["straight", "Straight"],
    ["uturn", "UTurnLeft"],
    ["merge_to_right", "MergeType"],
    ["sharp_left", "TurnSharpLeft"],
    ["slight_right", "TurnSlightRight"],
    ["wat", "Straight"],
  ] as const;
  for (const [token, expected] of cases) expect(laneIndicationIconName(token)).toBe(expected);
});

it("preserves unmarked plain directions and rejects nondirectional maneuvers", () => {
  expect(unmarkedLaneIconName(undefined)).toBeNull();
  const cases = [
    [{ type: "fork", modifier: "slight left" }, "TurnSlightLeft"],
    [{ type: "keep", modifier: "right" }, "TurnSlightRight"],
    [{ type: "turn", modifier: "left" }, "TurnLeft"],
    [{ type: "continue", modifier: "straight" }, "Straight"],
    [{ type: "roundabout", modifier: "left" }, null],
    [{ type: "merge", modifier: "left" }, null],
  ] as const;
  for (const [maneuver, expected] of cases) expect(unmarkedLaneIconName(maneuver)).toBe(expected);
});
