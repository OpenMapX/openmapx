import type { EvChargingStatus } from "@openmapx/mobility-core/ev-charging";

export function classifyEvseStatus(raw: string | undefined): EvChargingStatus | null {
  const upper = raw?.toUpperCase() ?? "";
  if (upper === "AVAILABLE" || upper === "CHARGING" || upper === "BLOCKED" || upper === "RESERVED")
    return "operational";
  if (upper === "PLANNED") return "planned";
  if (upper === "INOPERATIVE" || upper === "OUTOFORDER" || upper === "REMOVED")
    return "not-operational";
  return null;
}

export function aggregateStationStatus(
  perEvse: ReadonlyArray<EvChargingStatus | null>,
): EvChargingStatus {
  let sawOperational = false;
  let sawPlanned = false;
  let sawNotOperational = false;
  let sawKnown = false;
  for (const status of perEvse) {
    if (status === null) continue;
    sawKnown = true;
    if (status === "operational") sawOperational = true;
    else if (status === "planned") sawPlanned = true;
    else if (status === "not-operational") sawNotOperational = true;
  }
  if (!sawKnown) return "unknown";
  if (sawOperational) return "operational";
  if (sawPlanned) return "planned";
  if (sawNotOperational) return "not-operational";
  return "unknown";
}

export interface EvseStatusSummary {
  available: number;
  hasKnownStatus: boolean;
  status: EvChargingStatus;
  total: number;
}

export function summarizeEvseStatuses(
  rawStatuses: ReadonlyArray<string | undefined>,
): EvseStatusSummary {
  const statuses: Array<EvChargingStatus | null> = [];
  let available = 0;
  let total = 0;

  for (const rawStatus of rawStatuses) {
    const normalized = rawStatus?.toUpperCase() ?? "";
    if (normalized === "AVAILABLE") available += 1;
    if (normalized !== "REMOVED") total += 1;
    statuses.push(classifyEvseStatus(rawStatus));
  }

  return {
    available,
    hasKnownStatus: statuses.some((status) => status !== null),
    status: aggregateStationStatus(statuses),
    total,
  };
}
