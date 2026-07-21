import type { Route } from "@openmapx/core";
import type { EvVehicleSpec } from "./types";

/** Potential-energy per metre of climb, Wh, per tonne (g=9.81, 1 kWh=3.6e6 J). */
const GRAVITY_WH_PER_M_PER_TONNE = (9.81 * 1000) / 3600; // ≈ 2.725
const REGEN_FACTOR = 0.6;

export interface ConsumptionOpts {
  ambientTempC: number;
  /** Multiplier applied to total energy when the route has no elevation. */
  elevationAbsentDerate?: number;
}

/** U-shaped derate: ~1.0 near 20°C, steep in cold (heating + battery), mild in heat (A/C). */
export function tempDerate(tempC: number): number {
  const d = tempC - 20;
  return 1 + (d < 0 ? 0.012 * -d : 0.004 * d); // e.g. -10°C → 1.36, 40°C → 1.08
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Energy over a route. When `route.elevation[]` is present, integrate along its
 * 30 m samples (climb costs PE, descent recovers REGEN_FACTOR of it). When
 * absent, use distance * baseWhPerKm and apply `elevationAbsentDerate` as a
 * safety uplift. Returns total and a cumulative array aligned to the sample axis
 * used (elevation samples, else geometry vertices).
 *
 * Deliberate Phase-1 simplification (diverges from spec D3): the per-road
 * `speedFactor(stepSpeedKph)` term is NOT implemented — `baseWhPerKm` is
 * treated as speed-independent. Highway vs. city aero drag is folded into the
 * per-vehicle constant. The spec's speed term is a Phase-2 refinement; the
 * function signature leaves room (`ConsumptionOpts`) to add it without changing
 * callers. This is called out in the spec's §9 Phase-2 list.
 */
export function routeEnergyKwh(
  route: Route,
  vehicle: EvVehicleSpec,
  opts: ConsumptionOpts,
): { totalKwh: number; cumulativeKwh: number[] } {
  const temp = tempDerate(opts.ambientTempC);
  const cumulative: number[] = [0];
  let total = 0;

  if (route.elevation && route.elevation.length >= 2 && route.elevationInterval) {
    const segKm = route.elevationInterval / 1000;
    for (let i = 1; i < route.elevation.length; i++) {
      const flatWh = segKm * vehicle.baseWhPerKm;
      const dEle = route.elevation[i] - route.elevation[i - 1];
      const gravWh =
        dEle >= 0
          ? dEle * GRAVITY_WH_PER_M_PER_TONNE * vehicle.massTonnes
          : REGEN_FACTOR * dEle * GRAVITY_WH_PER_M_PER_TONNE * vehicle.massTonnes;
      const segWh = Math.max(0, flatWh + gravWh) * temp;
      total += segWh;
      cumulative.push(total / 1000);
    }
    return { totalKwh: total / 1000, cumulativeKwh: cumulative };
  }

  const derate = opts.elevationAbsentDerate ?? 1;
  for (let i = 1; i < route.geometry.length; i++) {
    const km = haversineKm(route.geometry[i - 1], route.geometry[i]);
    total += km * vehicle.baseWhPerKm * temp * derate;
    cumulative.push(total / 1000);
  }
  return { totalKwh: total / 1000, cumulativeKwh: cumulative };
}
