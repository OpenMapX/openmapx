export interface ChargeInput {
  fromSocKwh: number;
  toSocKwh: number;
  batteryKwh: number;
  chargerPowerKw: number;
  vehicleMaxKw: number;
  taperSocPct: number;
}

/** Effective power (kW) at a given SoC fraction: flat to taper, linear decay above. */
function powerAt(socFrac: number, peakKw: number, taperFrac: number): number {
  if (socFrac <= taperFrac) return peakKw;
  // Decay from peak at taper to ~15% peak at 100%.
  const t = (socFrac - taperFrac) / (1 - taperFrac);
  return peakKw * (1 - 0.85 * t);
}

/**
 * Seconds to move from `fromSocKwh` to `toSocKwh`, integrating a piecewise
 * charging curve in small SoC steps. Peak power is the slower of the charger and
 * the vehicle's acceptance; above `taperSocPct` power decays linearly.
 */
export function chargeSecondsFor(input: ChargeInput): number {
  const peakKw = Math.min(input.chargerPowerKw, input.vehicleMaxKw);
  if (peakKw <= 0 || input.toSocKwh <= input.fromSocKwh) return 0;
  const taperFrac = input.taperSocPct / 100;
  const stepKwh = input.batteryKwh / 200; // 0.5% battery steps
  let seconds = 0;
  for (let e = input.fromSocKwh; e < input.toSocKwh; e += stepKwh) {
    const chunk = Math.min(stepKwh, input.toSocKwh - e);
    const midFrac = (e + chunk / 2) / input.batteryKwh;
    const kw = powerAt(midFrac, peakKw, taperFrac);
    seconds += (chunk / kw) * 3600;
  }
  return seconds;
}
