import { describe, expect, it } from "vitest";
import { isWildfirePolygonGeometry } from "./polygon-geometry.js";
import {
  INVALID_WILDFIRE_POLYGON_GEOMETRIES,
  VALID_WILDFIRE_POLYGON_GEOMETRIES,
} from "./polygon-geometry.test-data.js";

describe("isWildfirePolygonGeometry", () => {
  it.each(VALID_WILDFIRE_POLYGON_GEOMETRIES)("accepts $name", ({ geometry }) => {
    expect(isWildfirePolygonGeometry(geometry)).toBe(true);
  });

  it.each(INVALID_WILDFIRE_POLYGON_GEOMETRIES)("rejects $name", ({ geometry }) => {
    expect(isWildfirePolygonGeometry(geometry)).toBe(false);
  });
});
