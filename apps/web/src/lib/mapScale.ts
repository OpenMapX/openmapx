import type { UnitSystem } from "@openmapx/core";

export interface MapScale {
  value: number;
  unit: "m" | "km" | "ft" | "mi";
  /** Length of the bar in CSS pixels, at most the width it was measured over. */
  width: number;
}

const FEET_PER_METRE = 3.2808;
const FEET_PER_MILE = 5280;

/** The largest 1, 2, 3 or 5 times a power of ten that does not exceed `n`. */
function roundDown(n: number): number {
  const pow10 = 10 ** Math.floor(Math.log10(n));
  const d = n / pow10;
  return pow10 * (d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1);
}

/**
 * A scale bar for a map on which `maxWidth` CSS pixels span `metres`: a round
 * distance no longer than that span, in the larger unit once it reaches one
 * kilometre or one mile, and the bar width that represents it.
 */
export function mapScale(metres: number, maxWidth: number, units: UnitSystem): MapScale | null {
  if (!(metres > 0) || !(maxWidth > 0)) return null;
  const [span, small, large, perLarge] =
    units === "imperial"
      ? ([metres * FEET_PER_METRE, "ft", "mi", FEET_PER_MILE] as const)
      : ([metres, "m", "km", 1000] as const);
  const inLarge = span >= perLarge;
  const max = inLarge ? span / perLarge : span;
  const value = roundDown(max);
  return { value, unit: inLarge ? large : small, width: Math.round((maxWidth * value) / max) };
}
