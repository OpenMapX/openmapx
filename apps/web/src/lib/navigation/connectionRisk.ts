export type ConnectionRiskLevel = "ok" | "tight" | "missed";

export interface ConnectionRisk {
  /** Spare seconds after walking the transfer (negative = the change is missed). */
  bufferSeconds: number;
  level: ConnectionRiskLevel;
}

/**
 * Assess whether an onward connection is safe, tight, or missed: the spare time
 * between arriving on the current leg and the next leg's departure, minus the
 * transfer walk. Uses realtime arrival/departure times so a growing delay eats
 * the buffer live. Returns `ok` with a zero buffer when a time is unknown (can't
 * assess — don't alarm). Pure and unit-tested.
 */
export function connectionRisk(input: {
  currentArrivalMs: number;
  nextDepartureMs: number;
  transferWalkSeconds: number;
  tightThresholdSeconds?: number;
}): ConnectionRisk {
  const {
    currentArrivalMs,
    nextDepartureMs,
    transferWalkSeconds,
    tightThresholdSeconds = 120,
  } = input;
  if (!Number.isFinite(currentArrivalMs) || !Number.isFinite(nextDepartureMs)) {
    return { bufferSeconds: 0, level: "ok" };
  }
  const bufferSeconds =
    Math.round((nextDepartureMs - currentArrivalMs) / 1000) - Math.max(0, transferWalkSeconds);
  const level: ConnectionRiskLevel =
    bufferSeconds < 0 ? "missed" : bufferSeconds < tightThresholdSeconds ? "tight" : "ok";
  return { bufferSeconds, level };
}
