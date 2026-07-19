import type { TripLeg } from "@openmapx/mobility-core/transit";
import { nextTransferFor } from "./transitTransfer";

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

/**
 * The tightest transfer in a planned itinerary, using SCHEDULED times (so it's a
 * plan-time robustness signal, not a live one): for each transit leg with an
 * onward change, the scheduled buffer minus the transfer walk. Returns the worst
 * non-ok risk, or null when every change has comfortable slack. A short
 * scheduled buffer is the one most likely to break if anything runs late.
 */
export function itineraryTransferRisk(
  legs: TripLeg[],
  tightThresholdSeconds = 180,
): ConnectionRisk | null {
  let worst: ConnectionRisk | null = null;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mode === "walking" || !leg.route) continue;
    const transfer = nextTransferFor(legs, i);
    if (!transfer) continue;
    const risk = connectionRisk({
      currentArrivalMs: new Date(leg.scheduledEndTime ?? leg.endTime).getTime(),
      nextDepartureMs: new Date(
        transfer.nextLeg.scheduledStartTime ?? transfer.nextLeg.startTime,
      ).getTime(),
      transferWalkSeconds: transfer.walkSeconds,
      tightThresholdSeconds,
    });
    if (risk.level !== "ok" && (!worst || risk.bufferSeconds < worst.bufferSeconds)) {
      worst = risk;
    }
  }
  return worst;
}
