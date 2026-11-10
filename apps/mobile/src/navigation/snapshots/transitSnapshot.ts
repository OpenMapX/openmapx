import {
  NATIVE_SNAPSHOT_VERSION,
  prepareTransitProgress,
  stripTransitSecretsForSnapshot,
  type TransitFullSnapshot,
  type TransitMobileSession,
  type TransitProgressSnapshot,
  transitProgressFromTick,
} from "@openmapx/core/navigation";

/**
 * What the page is told about a transit session.
 *
 * The rotating refresh token is the value this file exists to keep out. Native
 * is its exclusive consumer; it must not reach the page, a diagnostic, a
 * notification row or an error string. So the projection strips it
 * rather than assembling around it: an allowlist would leak the first time the
 * server moved the field, and a session's itinerary is server-shaped.
 */

function liveStatus(session: TransitMobileSession) {
  return {
    refresh: session.payload.refresh.status,
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
    version: NATIVE_SNAPSHOT_VERSION,
    type: "full",
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    kind: "transit",
    itineraryFingerprint: startPackage.itineraryFingerprint,
    itinerary: stripTransitSecretsForSnapshot(structuredClone(startPackage.itinerary)),
    captures: stripTransitSecretsForSnapshot(structuredClone(startPackage.captures)),
    transitReplanOptions: stripTransitSecretsForSnapshot(startPackage.replanOptions ?? null),
    currentLegIndex: tickState.currentLegIndex,
    currentWalkStepIndex: tickState.currentWalkStepIndex,
    phase: tickState.phase,
    confidence: session.payload.confidence,
    // Spread into a plain record, which is what the snapshot carries.
    transitProgress: {
      ...structuredClone(
        session.payload.progress ??
          transitProgressFromTick(
            {
              ...tickState,
              ...(session.lastAcceptedFix ? { lastAcceptedFix: session.lastAcceptedFix } : {}),
            },
            prepareTransitProgress(startPackage.itinerary as never),
          ),
      ),
    },
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
    version: NATIVE_SNAPSHOT_VERSION,
    type: "progress",
    sessionId: session.sessionId,
    revision: session.revision,
    itineraryFingerprint: session.payload.startPackage.itineraryFingerprint,
    status: session.status,
    currentLegIndex: tickState.currentLegIndex,
    currentWalkStepIndex: tickState.currentWalkStepIndex,
    phase: tickState.phase,
    confidence: session.payload.confidence,
    transitProgress: structuredClone(session.payload.progress),
    connectivity: session.connectivity,
    liveStatus: liveStatus(session),
  };
}
