import { describe, expect, it } from "vitest";
import {
  direction,
  firstSport,
  laneCount,
  laneList,
  roadWidth,
  signalDirection,
  treeCirc,
  treeCrown,
  treeHeight,
} from "../web/derive/validate";

describe("attribute validation", () => {
  it.each([
    [roadWidth, 2, 40, [1.9, 40.1, Number.NaN, "7", undefined]],
    [treeHeight, 2, 45, [1, 46, -3, undefined]],
    [treeCrown, 1, 30, [0.5, 31, undefined]],
    [treeCirc, 0.1, 8, [0.05, 9, undefined]],
  ] as const)("accepts the range %#", (check, min, max, rejected) => {
    expect(check(min)).toBe(min);
    expect(check(max)).toBe(max);
    expect(check((min + max) / 2)).toBe((min + max) / 2);
    for (const value of rejected) expect(check(value as never)).toBeNull();
  });

  it("accepts whole lane counts from 1 to 8", () => {
    expect(laneCount(1)).toBe(1);
    expect(laneCount(8)).toBe(8);
    for (const value of [0, 9, 2.5, -1, undefined, "2"])
      expect(laneCount(value as never)).toBeNull();
  });

  it("reads directions in degrees or as 16-point compass names", () => {
    expect(direction("NE")).toBe(45);
    expect(direction("SSW")).toBe(202.5);
    expect(direction("n")).toBe(0);
    expect(direction("270")).toBe(270);
    expect(direction(90)).toBe(90);
    expect(direction("360")).toBe(360);
    for (const value of ["361", "-5", "forward", "", undefined, "NNNE"])
      expect(direction(value as never)).toBeNull();
  });

  it("reads signal directions with both as the fallback", () => {
    expect(signalDirection("forward")).toBe("forward");
    expect(signalDirection("backward")).toBe("backward");
    expect(signalDirection("both")).toBe("both");
    expect(signalDirection("sideways")).toBe("both");
    expect(signalDirection(undefined)).toBe("both");
  });

  it("accepts lane lists only when their length matches the lane count", () => {
    expect(laneList("left|through", 2)).toEqual(["left", "through"]);
    expect(laneList("left|through", 3)).toBeNull();
    expect(laneList("left;through||right", 3)).toEqual(["left;through", "", "right"]);
    expect(laneList(undefined, 2)).toBeNull();
    expect(laneList("", 1)).toBeNull();
    expect(laneList("left", null)).toBeNull();
  });

  it("takes the first sport of a list", () => {
    expect(firstSport("soccer;basketball")).toBe("soccer");
    expect(firstSport(" tennis ")).toBe("tennis");
    expect(firstSport("")).toBeNull();
    expect(firstSport(undefined)).toBeNull();
  });
});
