/**
 * Shared MOTIS `Alert` → canonical {@link ServiceAlert} mapper. Used by both the
 * baseline planning adapter (to attach alerts to itinerary legs) and the
 * realtime provider (stop-alert lookups), so the two can't drift on which
 * fields survive — MOTIS carries `url`, `cause` and TTS text the old per-provider
 * mapper discarded.
 */

import type { Alert, AlertSeverityLevel } from "@motis-project/motis-client";
import type { AlertSeverity, ServiceAlert } from "./types/transit.js";

export function mapMotisAlertSeverity(level?: AlertSeverityLevel): AlertSeverity {
  switch (level) {
    case "SEVERE":
      return "severe";
    case "WARNING":
      return "warning";
    case "INFO":
      return "info";
    default:
      return "info";
  }
}

export interface MapMotisAlertOptions {
  /** Position within the alert list; used for a stable id when `code` is absent. */
  index?: number;
  /** Prepended to the id seed to namespace ids by source (e.g. "mr:"). */
  idPrefix?: string;
  /** Source ids that produced the alert. */
  providers?: string[];
  affectedRouteIds?: string[];
  affectedStopIds?: string[];
}

export function mapMotisAlert(alert: Alert, opts: MapMotisAlertOptions = {}): ServiceAlert {
  const idSeed = alert.code ?? `${alert.headerText}-${opts.index ?? 0}`;
  const periods = (alert.impactPeriod ?? []).flatMap((range) =>
    range.start ? [{ start: range.start, end: range.end ?? undefined }] : [],
  );

  return {
    id: `${opts.idPrefix ?? ""}${idSeed}`,
    providers: opts.providers ?? [],
    severity: mapMotisAlertSeverity(alert.severityLevel),
    effect: alert.effect ?? alert.effectDetail ?? undefined,
    cause: alert.cause ?? alert.causeDetail ?? undefined,
    title: alert.headerText,
    description: alert.descriptionText || undefined,
    ttsTitle: alert.ttsHeaderText || undefined,
    ttsDescription: alert.ttsDescriptionText || undefined,
    url: alert.url || undefined,
    imageUrl: alert.imageUrl || undefined,
    affectedRouteIds: opts.affectedRouteIds ?? [],
    affectedStopIds: opts.affectedStopIds ?? [],
    activePeriods: periods,
  };
}
