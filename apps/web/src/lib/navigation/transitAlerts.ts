import type { ServiceAlert, TripLeg } from "@openmapx/mobility-core/transit";
import { SEVERITY_PRIORITY } from "@/components/panels/transit/AlertCard";

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
