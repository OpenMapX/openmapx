import type { TripLeg } from "@openmapx/mobility-core/transit";

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
