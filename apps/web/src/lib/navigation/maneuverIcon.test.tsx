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

  it("maps forks and ramps (OSRM on/off ramp) to a diagonal arrow, not a fork glyph", () => {
    // Bare left/right are promoted to their slight (diagonal) variant.
    expect(maneuverIconFor({ type: "fork", modifier: "right" }).name).toBe("TurnSlightRight");
    expect(maneuverIconFor({ type: "off ramp", modifier: "left" }).name).toBe("TurnSlightLeft");
    expect(maneuverIconFor({ type: "on ramp", modifier: "right" }).name).toBe("TurnSlightRight");
    // Explicit slight/sharp granularity is preserved.
    expect(maneuverIconFor({ type: "off ramp", modifier: "slight right" }).name).toBe(
      "TurnSlightRight",
    );
    expect(maneuverIconFor({ type: "on ramp", modifier: "slight left" }).name).toBe(
      "TurnSlightLeft",
    );
    expect(maneuverIconFor({ type: "fork", modifier: "sharp left" }).name).toBe("TurnSharpLeft");
    // A straight/unspecified fork stays a straight arrow.
    expect(maneuverIconFor({ type: "fork", modifier: "straight" }).name).toBe("Straight");
    expect(maneuverIconFor({ type: "fork" }).name).toBe("Straight");
  });

  it("maps roundabouts/rotaries (incl. OSRM exit variants) to a roundabout icon", () => {
    expect(maneuverIconFor({ type: "roundabout" }).name).toBe("RoundaboutRight");
    expect(maneuverIconFor({ type: "rotary", modifier: "left" }).name).toBe("RoundaboutLeft");
    expect(maneuverIconFor({ type: "exit roundabout", modifier: "right" }).name).toBe(
      "RoundaboutRight",
    );
    expect(maneuverIconFor({ type: "exit rotary", modifier: "left" }).name).toBe("RoundaboutLeft");
  });

  it("maps merge to a merge icon", () => {
    expect(maneuverIconFor({ type: "merge", modifier: "slight left" }).name).toBe("MergeType");
  });

  it("maps keep maneuvers to gentle directional arrows instead of fork glyphs", () => {
    expect(maneuverIconFor({ type: "keep", modifier: "left" }).name).toBe("TurnSlightLeft");
    expect(maneuverIconFor({ type: "keep", modifier: "right" }).name).toBe("TurnSlightRight");
    expect(maneuverIconFor({ type: "keep", modifier: "straight" }).name).toBe("Straight");
  });

  it("maps OSRM end-of-road / continue / new name to a directional arrow", () => {
    expect(maneuverIconFor({ type: "end of road", modifier: "left" }).name).toBe("TurnLeft");
    expect(maneuverIconFor({ type: "continue", modifier: "slight right" }).name).toBe(
      "TurnSlightRight",
    );
    expect(maneuverIconFor({ type: "new name", modifier: "straight" }).name).toBe("Straight");
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
