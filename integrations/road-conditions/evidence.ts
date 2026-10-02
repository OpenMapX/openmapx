import type { RoadConditionEvent } from "@openmapx/core";

/**
 * Whether a situation is an UNCONFIRMED crowd report — a user-submitted
 * condition that has not been externally resolved. The overlay renders these
 * distinctly (an "unconfirmed" badge) so a user can tell a corroborated
 * official closure from a lone self-report.
 *
 * This is labeling-only and independent of the routing gate: routing keys off
 * `evidence.routingEligible`, while the map key is evidence maturity — a crowd
 * situation stays "unconfirmed" until its evidence reaches
 * `"externally_resolved"`.
 */
export function isUnconfirmedCrowd(
  event: Pick<RoadConditionEvent, "origin" | "evidence">,
): boolean {
  return event.origin === "crowd" && event.evidence?.state !== "externally_resolved";
}
