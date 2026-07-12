/**
 * Whether an event is an UNCONFIRMED crowd report — a user-submitted condition
 * that has not been externally resolved. The overlay renders these distinctly
 * (e.g. a dashed style or an "unconfirmed" badge) so an operator/user can tell a
 * corroborated official closure from a lone self-report.
 *
 * This is labeling-only and independent of the routing gate: routing keys off
 * `routingEligible` (see `integrations/routing/closures.ts`), while the map key
 * is evidence maturity — a crowd event stays "unconfirmed" until its
 * `evidenceState` reaches `"externally_resolved"`. Accepts a loose shape so it
 * works on both a `RoadConditionEvent` and a flattened GeoJSON feature's
 * `properties`.
 */
export function isUnconfirmedCrowd(input: {
  originKind?: string | null;
  evidenceState?: string | null;
}): boolean {
  return input.originKind === "crowd" && input.evidenceState !== "externally_resolved";
}
