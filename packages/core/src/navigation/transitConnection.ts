import type {
  AlertSeverity,
  ServiceAlert,
  TransitPlace,
  TripLeg,
} from "@openmapx/mobility-core/transit";

/**
 * Transfer, connection-risk, platform and service-alert logic, shared by the
 * browser and the installed shell.
 *
 * These were browser-only until the shell needed to reach the same conclusions
 * while the page was suspended. Two implementations of "is this connection
 * missed?" would eventually disagree, and the disagreement would surface as the
 * app and the site telling one rider two different things about the same train.
 *
 * Everything here is pure and free of React, so it runs identically in a
 * background callback.
 */

/** Most severe first. Shared so a banner and a spoken cue rank alerts alike. */
export const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  critical: 4,
  severe: 3,
  warning: 2,
  info: 1,
};

export interface TransitTransfer {
  /** The next transit leg the rider changes onto. */
  nextLeg: TripLeg;
  /** Total walking time between the current leg and `nextLeg`, in seconds. */
  walkSeconds: number;
}

/**
 * Find the transit leg the rider changes onto after `currentIndex`, plus the
 * walking time to reach it (summed across any intervening walk legs). Returns
 * null when no further transit leg follows — i.e. the current leg is the last
 * ride and the rider is arriving, not transferring.
 */
export function nextTransferFor(legs: TripLeg[], currentIndex: number): TransitTransfer | null {
  let walkSeconds = 0;
  for (let i = currentIndex + 1; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mode !== "walking" && leg.route) {
      return { nextLeg: leg, walkSeconds };
    }
    walkSeconds += leg.durationSeconds ?? 0;
  }
  return null;
}

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

/**
 * The scheduled platform, but only when a realtime update has moved boarding to
 * a different track — i.e. both are known and they differ. Returns undefined
 * otherwise (no change, or one side unknown), which reads as "no platform
 * change to flag".
 */
export function changedFromPlatform(
  place: Pick<TransitPlace, "platformCode" | "scheduledPlatformCode">,
): string | undefined {
  const { platformCode, scheduledPlatformCode } = place;
  if (platformCode && scheduledPlatformCode && platformCode !== scheduledPlatformCode) {
    return scheduledPlatformCode;
  }
  return undefined;
}

/**
 * Collect the service alerts relevant to the rest of the trip — those on the
 * current and upcoming legs — deduped by id and sorted most-severe first. Used
 * both by the in-nav alert banner and by voice guidance.
 */
export function collectActiveAlerts(legs: TripLeg[], currentLegIndex: number): ServiceAlert[] {
  const byId = new Map<string, ServiceAlert>();
  for (const leg of legs.slice(Math.max(0, currentLegIndex))) {
    for (const alert of leg.alerts ?? []) {
      if (!byId.has(alert.id)) byId.set(alert.id, alert);
    }
  }
  return [...byId.values()].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
}
