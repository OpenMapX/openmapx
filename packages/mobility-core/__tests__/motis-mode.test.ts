import { describe, expect, it } from "vitest";
import { motisMode } from "../src/motis-radar.js";

describe("motisMode", () => {
  it.each([
    ["HIGHSPEED_RAIL", "rail"],
    ["SUBURBAN", "rail"],
    ["SUBWAY", "subway"],
    ["AERIAL_LIFT", "gondola"],
    ["MONORAIL", "monorail"],
    ["WALK", "walking"],
    ["BIKE", "cycling"],
    ["COACH", "bus"],
  ])("maps %s to %s", (mode, expected) => {
    expect(motisMode(mode)).toBe(expected);
  });

  it("treats an unknown or missing mode as a bus", () => {
    expect(motisMode("HOVERCRAFT")).toBe("bus");
    expect(motisMode(undefined)).toBe("bus");
  });
});
