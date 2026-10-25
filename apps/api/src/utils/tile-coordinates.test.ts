import { describe, expect, it } from "vitest";
import { parseWebMercatorTileCoordinates } from "./tile-coordinates.js";

describe("parseWebMercatorTileCoordinates", () => {
  it.each([
    ["negative zoom", "-1", "0", "0", 22],
    ["fractional x", "1", "0.5", "0", 22],
    ["zoom above the provider ceiling", "23", "0", "0", 22],
    ["x outside the zoom world", "2", "4", "0", 22],
    ["y outside the zoom world", "2", "0", "4", 22],
    ["unsafe decimal integer", "2", "9007199254740993", "0", 22],
  ])("rejects %s", (_label, z, x, y, maxZoom) => {
    expect(parseWebMercatorTileCoordinates(z, x, y, maxZoom)).toBeNull();
  });

  it("accepts the exact maximum tile and preserves decimal parsing", () => {
    expect(parseWebMercatorTileCoordinates("22", "04194303", "4194303", 22)).toEqual({
      z: 22,
      x: 4_194_303,
      y: 4_194_303,
    });
  });
});
