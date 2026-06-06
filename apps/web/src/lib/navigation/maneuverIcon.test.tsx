import { describe, expect, it } from "vitest";
import { laneIndicationIcon, maneuverIconFor } from "./maneuverIcon";

describe("maneuverIconFor", () => {
  it("maps left/right modifiers", () => {
    expect(maneuverIconFor({ type: "turn", modifier: "left" }).name).toContain("TurnLeft");
    expect(maneuverIconFor({ type: "turn", modifier: "right" }).name).toContain("TurnRight");
  });
  it("falls back to Straight for unknown", () => {
    expect(maneuverIconFor(undefined).name).toContain("Straight");
  });
  it("maps arrive to a flag", () => {
    expect(maneuverIconFor({ type: "arrive" }).name).toContain("Flag");
  });
});

describe("laneIndicationIcon", () => {
  it("returns null for an empty 'none' lane (blank cell)", () => {
    expect(laneIndicationIcon("none")).toBeNull();
    expect(laneIndicationIcon("")).toBeNull();
  });

  it("maps OSRM space-separated tokens", () => {
    expect(laneIndicationIcon("left")?.name).toBe("TurnLeft");
    expect(laneIndicationIcon("right")?.name).toBe("TurnRight");
    expect(laneIndicationIcon("slight left")?.name).toBe("TurnSlightLeft");
    expect(laneIndicationIcon("slight right")?.name).toBe("TurnSlightRight");
    expect(laneIndicationIcon("sharp left")?.name).toBe("TurnSharpLeft");
    expect(laneIndicationIcon("sharp right")?.name).toBe("TurnSharpRight");
    expect(laneIndicationIcon("straight")?.name).toBe("Straight");
    expect(laneIndicationIcon("uturn")?.name).toBe("UTurnLeft");
    expect(laneIndicationIcon("merge_to_left")?.name).toBe("MergeType");
    expect(laneIndicationIcon("merge_to_right")?.name).toBe("MergeType");
  });

  it("maps Valhalla synonyms and underscores", () => {
    expect(laneIndicationIcon("through")?.name).toBe("Straight");
    expect(laneIndicationIcon("reverse")?.name).toBe("UTurnLeft");
    expect(laneIndicationIcon("sharp_left")?.name).toBe("TurnSharpLeft");
    expect(laneIndicationIcon("slight_right")?.name).toBe("TurnSlightRight");
  });

  it("falls back to Straight for an unrecognized token", () => {
    expect(laneIndicationIcon("wat")?.name).toBe("Straight");
  });
});
