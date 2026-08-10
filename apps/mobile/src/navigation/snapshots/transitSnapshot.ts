import {
  stripTransitSecretsForSnapshot,
  type TransitMobileSession,
} from "@openmapx/core/navigation";

/**
 * What the page is told about a transit session.
 *
 * The rotating refresh token is the value this file exists to keep out. Native
 * is its exclusive consumer; it must not reach the page, the outbox, a
 * diagnostic, a notification row or an error string. So the projection strips it
 * rather than assembling around it: an allowlist would leak the first time the
 * server moved the field, and a session's itinerary is server-shaped.
 */

export const TRANSIT_SNAPSHOT_VERSION = 1 as const;

export interface TransitFullSnapshot {
  version: typeof TRANSIT_SNAPSHOT_VERSION;
  type: "full";
  sessionId: string;
  revision: number;
  status: TransitMobileSession["status"];
  kind: "transit";
  itineraryFingerprint: string;
  itinerary: unknown;
  captures: unknown;
  currentLegIndex: number;
  currentWalkStepIndex: number;
  phase: string;
  confidence: TransitMobileSession["payload"]["confidence"];
  progress: unknown;
  settings: unknown;
  locale: "en" | "de";
  units: "metric" | "imperial";
  connectivity: TransitMobileSession["connectivity"];
  permissionMode: TransitMobileSession["permissionMode"];
  /** Whether live data is current, and whether a replan is wanted or stuck. */
  liveStatus: { refresh: string; replan: string; hasLiveToken: boolean };
  /** Whether the local get-off backup could actually be scheduled. */
  alightAlertAvailability: "scheduled" | "unavailable" | "disabled";
}

export interface TransitProgressSnapshot {
  version: typeof TRANSIT_SNAPSHOT_VERSION;
  type: "progress";
  sessionId: string;
  revision: number;
  itineraryFingerprint: string;
  status: TransitMobileSession["status"];
  currentLegIndex: number;
  currentWalkStepIndex: number;
  phase: string;
  confidence: TransitMobileSession["payload"]["confidence"];
  progress: unknown;
  connectivity: TransitMobileSession["connectivity"];
  liveStatus: { refresh: string; replan: string; hasLiveToken: boolean };
}

export type TransitSnapshot = TransitFullSnapshot | TransitProgressSnapshot;

function liveStatus(session: TransitMobileSession) {
  return {
    refresh: session.payload.refresh.status,
    replan: session.payload.replan.status,
    // Whether a token exists, never what it is. The page needs to know live data
    // is possible; it has no use for the value and no business holding it.
    hasLiveToken: session.payload.refreshToken !== null,
  };
}

function alightAvailability(
  session: TransitMobileSession,
): TransitFullSnapshot["alightAlertAvailability"] {
  if (!session.payload.startPackage.settings.alightAlertsEnabled) return "disabled";
  return session.payload.scheduledAlerts.length > 0 ? "scheduled" : "unavailable";
}

export function transitFullSnapshot(session: TransitMobileSession): TransitFullSnapshot {
  const { startPackage, tickState } = session.payload;
  return {
    version: TRANSIT_SNAPSHOT_VERSION,
    type: "full",
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    kind: "transit",
    itineraryFingerprint: startPackage.itineraryFingerprint,
    itinerary: stripTransitSecretsForSnapshot(structuredClone(startPackage.itinerary)),
    captures: stripTransitSecretsForSnapshot(structuredClone(startPackage.captures)),
    currentLegIndex: tickState.currentLegIndex,
    currentWalkStepIndex: tickState.currentWalkStepIndex,
    phase: tickState.phase,
    confidence: session.payload.confidence,
    progress: structuredClone(session.payload.progress),
    settings: structuredClone(startPackage.settings),
    locale: session.locale,
    units: session.units,
    connectivity: session.connectivity,
    permissionMode: session.permissionMode,
    liveStatus: liveStatus(session),
    alightAlertAvailability: alightAvailability(session),
  };
}

export function transitProgressSnapshot(session: TransitMobileSession): TransitProgressSnapshot {
  const { tickState } = session.payload;
  return {
    version: TRANSIT_SNAPSHOT_VERSION,
    type: "progress",
    sessionId: session.sessionId,
    revision: session.revision,
    itineraryFingerprint: session.payload.startPackage.itineraryFingerprint,
    status: session.status,
    currentLegIndex: tickState.currentLegIndex,
    currentWalkStepIndex: tickState.currentWalkStepIndex,
    phase: tickState.phase,
    confidence: session.payload.confidence,
    progress: structuredClone(session.payload.progress),
    connectivity: session.connectivity,
    liveStatus: liveStatus(session),
  };
}
