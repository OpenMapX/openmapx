import { describe, expect, it } from "vitest";
import { metresToPixels, routeWidthExpression } from "../routeWidth";

const BERLIN = 52.52;

/** Evaluate `["interpolate", ["exponential", 2], ["zoom"], z0, v0, z1, v1]` at `zoom`. */
function evaluate(expression: unknown[], zoom: number): number {
  const [, , , z0, v0, z1, v1] = expression as [
    unknown,
    unknown,
    unknown,
    number,
    number,
    number,
    number,
  ];
  if (zoom <= z0) return v0;
  if (zoom >= z1) return v1;
  const t = (2 ** (zoom - z0) - 1) / (2 ** (z1 - z0) - 1);
  return v0 + (v1 - v0) * t;
}

describe("routeWidth", () => {
  it("3.2 m is about 8.8 px at z17 in Berlin", () => {
    expect(metresToPixels(3.2, BERLIN, 17)).toBeCloseTo(8.8, 1);
    expect(metresToPixels(3.2, BERLIN, 18)).toBeCloseTo(17.6, 1);
  });

  it("constant below the crossover zoom", () => {
    const expression = routeWidthExpression(8, 3.2, BERLIN);
    expect(expression.slice(0, 3)).toEqual(["interpolate", ["exponential", 2], ["zoom"]]);
    expect(evaluate(expression, 10)).toBe(8);
    expect(evaluate(expression, 16)).toBe(8);
    // Above the crossover the line is the real 3.2 m.
    expect(evaluate(expression, 18)).toBeCloseTo(metresToPixels(3.2, BERLIN, 18), 1);
    expect(evaluate(expression, 19)).toBeCloseTo(metresToPixels(3.2, BERLIN, 19), 1);
  });

  it("the casing offset stays 3 px at z18", () => {
    const line = routeWidthExpression(8, 3.2, BERLIN);
    const casing = routeWidthExpression(8, 3.2, BERLIN, 3);
    const traveled = routeWidthExpression(8, 3.2, BERLIN, -1);
    for (const zoom of [12, 17, 18, 19.5]) {
      expect(evaluate(casing, zoom) - evaluate(line, zoom)).toBeCloseTo(3, 6);
      expect(evaluate(line, zoom) - evaluate(traveled, zoom)).toBeCloseTo(1, 6);
    }
    expect(evaluate(casing, 10)).toBe(11);
    expect(evaluate(traveled, 10)).toBe(7);
  });
});
