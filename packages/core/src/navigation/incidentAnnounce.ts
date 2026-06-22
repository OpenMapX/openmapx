import type { IncidentAlert } from "./incidentProjection";

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * Builds the spoken announcement for a traffic incident ahead, e.g.
 * "Roadworks ahead in 800 metres". Closures append a "road closed" clause.
 * Pure: the caller supplies the already-formatted distance + an i18n `t` bound
 * to the `navigation` namespace.
 */
export function formatIncidentAnnouncement(
  alert: Pick<IncidentAlert, "eventType">,
  distance: string,
  t: Translate,
): string {
  const type = t(`incidentType.${alert.eventType}`);
  const base = t("incidentAhead", { type, distance });
  return alert.eventType === "road_closure" ? `${base} ${t("incidentRoadClosed")}` : base;
}
