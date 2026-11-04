import { describe, expect, it } from "vitest";
import {
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
