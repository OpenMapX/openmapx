export interface BreakpointBand {
  concentrationLow: number;
  concentrationHigh: number;
  indexLow: number;
  indexHigh: number;
}

export function truncateTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Concentration must be finite");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new RangeError("Decimals must be an integer from 0 through 12");
  }
  const factor = 10 ** decimals;
  return Math.trunc(value * factor + Number.EPSILON) / factor;
}

export function interpolateBreakpoint(
  value: number,
  bands: readonly BreakpointBand[],
): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const band = bands.find(
    ({ concentrationLow, concentrationHigh }) =>
      value >= concentrationLow && value <= concentrationHigh,
  );
  if (!band) return null;
  const span = band.concentrationHigh - band.concentrationLow;
  if (span === 0) return band.indexHigh;
  const index =
    ((band.indexHigh - band.indexLow) / span) * (value - band.concentrationLow) + band.indexLow;
  return Math.round(index);
}
