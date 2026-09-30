import { describe, expect, it } from "vitest";
import { gridScreenTilt } from "./AlignToStreetsIcon";

describe("gridScreenTilt", () => {
  it("leans the grid by its axis on a north-up map", () => {
    expect(gridScreenTilt(29, 0)).toBe(29);
    expect(gridScreenTilt(80, 0)).toBe(-10);
  });

  it("stands square once the map is turned onto the grid, from either side", () => {
    expect(gridScreenTilt(29, 29)).toBe(0);
    expect(gridScreenTilt(29, 119)).toBe(0);
    expect(gridScreenTilt(29, 299)).toBe(0);
  });

  it("folds into [−45, 45) because a grid repeats every 90°", () => {
    expect(gridScreenTilt(10, 300)).toBe(-20);
    expect(gridScreenTilt(0, 45)).toBe(-45);
    expect(gridScreenTilt(45, 0)).toBe(-45);
  });
});
