import { describe, expect, it } from "vitest";
import { maneuverIconFor } from "./maneuverIcon";

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
