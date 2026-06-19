/**
 * Average passenger-car tailpipe CO₂ emission factor (grams per km). Real-world
 * internal-combustion cars sit around ~170 g/km; the EEA's new-car figures are
 * lower (~110–120 g/km) but the on-road fleet average is higher. This is a
 * deliberately single-factor approximation (no engine-type or elevation
 * modelling) — surfaced only as an explicitly-labelled estimate.
 */
export const AVERAGE_CAR_CO2_GRAMS_PER_KM = 170;

/** Rough CO₂ estimate (grams) for driving a route of `distanceMeters`. */
export function estimateDrivingCo2Grams(distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  return (distanceMeters / 1000) * AVERAGE_CAR_CO2_GRAMS_PER_KM;
}
