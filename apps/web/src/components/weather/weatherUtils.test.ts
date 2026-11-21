import { expect, it } from "vitest";
import { windDirectionLabel } from "./weatherUtils";

it.each([
  [0, "N"],
  [44, "NE"],
  [180, "S"],
  [337.6, "N"],
  [360, "N"],
  [-90, "W"],
  [-45, "NW"],
  [765, "NE"],
])("labels %s° as %s", (deg, label) => {
  expect(windDirectionLabel(deg)).toBe(label);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY])("throws for the non-finite bearing %s", (deg) => {
  expect(() => windDirectionLabel(deg)).toThrow(RangeError);
});
