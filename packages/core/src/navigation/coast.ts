export interface CoastOptions {
  /** Wait until the last fix is at least this old (ms) before extrapolating. */
  startAfterMs: number;
  /** Decelerate the assumed speed to zero over this span (ms); position freezes after. */
  maxCoastMs: number;
  /** Hard cap on how far the position may coast past the last fix (m). */
  maxCoastMeters: number;
  /** Total route length (m); the coasted distance is clamped to it. */
  routeLengthMeters: number;
}

export interface CoastResult {
  /** True once the last fix is old enough that the shown position is extrapolated. */
  coasting: boolean;
  /** Extrapolated along-route distance (m). */
  alongMeters: number;
  /** Assumed ground speed at this instant (m/s), decaying toward zero. */
  speedMps: number;
}

/**
 * Extrapolate a route-constrained position through a GPS outage (tunnel, garage,
 * urban canyon). When fixes stop, the traveller is still on the route, so we
 * carry the along-route distance forward from the last fix at its speed —
 * linearly decelerating to a standstill over `maxCoastMs` so a stop in tunnel
 * traffic overshoots gently rather than sailing off, and bounding the total by
 * `maxCoastMeters` and the route length. Pure so it can be unit-tested against
 * synthetic fix gaps; the engine feeds the result back through the normal fix
 * pipeline as a synthetic on-route fix.
 */
export function coastState(
  lastAlongMeters: number,
  lastSpeedMps: number,
  ageMs: number,
  opts: CoastOptions,
): CoastResult {
  if (ageMs < opts.startAfterMs) {
    return { coasting: false, alongMeters: lastAlongMeters, speedMps: lastSpeedMps };
  }

  const maxMs = Math.max(opts.maxCoastMs, 1);
  const cappedAgeMs = Math.min(ageMs, maxMs);
  const ageSec = cappedAgeMs / 1000;
  const maxSec = maxMs / 1000;
  const s = Math.max(lastSpeedMps, 0);

  // Distance under a linear deceleration from s to 0 over maxSec: ∫ s(1 − t/maxSec) dt.
  const rawDist = s * ageSec * (1 - ageSec / (2 * maxSec));
  const dist = Math.min(rawDist, opts.maxCoastMeters);
  const alongMeters = Math.min(Math.max(lastAlongMeters + dist, 0), opts.routeLengthMeters);
  const speedMps = s * (1 - cappedAgeMs / maxMs);

  return { coasting: true, alongMeters, speedMps };
}
