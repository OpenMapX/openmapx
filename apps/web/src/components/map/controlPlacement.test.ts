import { describe, expect, it } from "vitest";
import { resolveControlPlacement } from "./controlPlacement";

describe("map control placement", () => {
  it("keeps a fitting stack above the sheet and below filters", () => {
    expect(resolveControlPlacement(800, 180, 280, 300, 180)).toEqual({
      columns: 1,
      bottom: 280,
    });
  });

  it("uses two columns when the full stack would enter the filter row", () => {
    expect(resolveControlPlacement(800, 280, 330, 260, 150)).toEqual({
      columns: 2,
      bottom: 330,
    });
  });

  it("lets an expanded sheet cover the grid without pushing it into filters", () => {
    expect(resolveControlPlacement(800, 300, 520, 300, 180)).toEqual({
      columns: 2,
      bottom: 308,
    });
  });

  it("keeps the grid below filters even when it exceeds the available viewport", () => {
    expect(resolveControlPlacement(320, 260, 240, 300, 120)).toEqual({
      columns: 2,
      bottom: -72,
    });
  });
});
