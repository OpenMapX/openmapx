import { expect, it } from "vitest";
import { compassPoint } from "../bearing";

it.each([
  [0, "N"],
  [44, "NE"],
  [180, "S"],
  [337.6, "N"],
  [360, "N"],
  [-90, "W"],
  [-45, "NW"],
  [765, "NE"],
])("names %s° %s", (deg, label) => {
  expect(compassPoint(deg)).toBe(label);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "names no direction for the non-finite bearing %s",
  (deg) => {
    expect(compassPoint(deg)).toBeUndefined();
  },
);
