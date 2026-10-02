import type { IncidentAlert } from "./incidentProjection";

type Translate = (key: string, values?: Record<string, string>) => string;

/** Registry situation types with a label in the `navigation.incidentType` catalog. */
const LABELLED_TYPES = new Set([
  "accident",
  "breakdown",
  "vehicle_hazard",
  "obstruction",
  "fire",
  "works",
  "closure",
  "dimension",
  "access",
  "speed",
  "seasonal_load",
  "weather",
  "surface",
  "driving_condition",
  "hazard",
  "event",
  "operation",
  "fault",
  "incident",
  "chain_control",
  "pass",
  "congestion",
  "other",
]);

/** The `navigation` catalog key naming an incident's type; an unknown type reads as "other". */
export function incidentTypeLabelKey(alert: Pick<IncidentAlert, "eventType">): string {
  return `incidentType.${LABELLED_TYPES.has(alert.eventType) ? alert.eventType : "other"}`;
}

/**
 * Builds the spoken announcement for a traffic incident ahead, e.g.
 * "Roadworks ahead in 800 metres". A situation that closes the road appends a
 * "road closed" clause, whatever its type. Pure: the caller supplies the
 * already-formatted distance + an i18n `t` bound to the `navigation` namespace.
 */
export function formatIncidentAnnouncement(
  alert: Pick<IncidentAlert, "eventType" | "closesRoad">,
  distance: string,
  t: Translate,
): string {
  const type = t(incidentTypeLabelKey(alert));
  const base = t("incidentAhead", { type, distance });
  return alert.closesRoad ? `${base} ${t("incidentRoadClosed")}` : base;
}
