import { useEffect, useState } from "react";
import type { DirectionsResult } from "../types/routing";
import { expireDirectionsRoadConditionImpact } from "../utils/roadConditionRouteImpact";

/** Re-render once at the lease boundary so held query data cannot stay current. */
export function useRoadConditionLease<T extends DirectionsResult>(
  data: T | undefined,
): T | undefined {
  const [leaseRevision, setLeaseRevision] = useState(0);
  const impact = data?.roadConditionImpact;

  useEffect(() => {
    if (impact?.availability !== "current") return;
    const deadline = impact.validUntil ? Date.parse(impact.validUntil) : NaN;
    const delay = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
    const timer = setTimeout(() => setLeaseRevision((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [impact?.availability, impact?.validUntil]);

  void leaseRevision;
  return expireDirectionsRoadConditionImpact(data, Date.now());
}
