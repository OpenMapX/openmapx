import type { TransitMobileSession } from "@openmapx/core/navigation";

/**
 * A schema-valid transit session with one ride between two walks.
 *
 * Built here rather than inline so a tightening of the shared schema surfaces
 * once instead of as a dozen separately-drifting fixtures — and so the rotating
 * token is one constant that leak tests can search for.
 */

export const FIXTURE_TOKEN = "tok_transit_rotating_secret";
export const FIXTURE_FINGERPRINT = "it-abc123-3";

const START = 1_700_000_100_000;

function place(stopId: string, name: string, platformCode?: string) {
  return { stopId, name, lat: 50.11, lng: 8.68, ...(platformCode ? { platformCode } : {}) };
}

export function transitItineraryFixture() {
  return {
    startTime: "2026-08-09T08:00:00Z",
    endTime: "2026-08-09T08:45:00Z",
    durationSeconds: 2_700,
    refreshToken: FIXTURE_TOKEN,
    legs: [
      {
        mode: "walking",
        from: place("origin", "Home"),
        to: place("stop-a", "Hauptbahnhof"),
        startTime: "2026-08-09T08:00:00Z",
        endTime: "2026-08-09T08:08:00Z",
        durationSeconds: 480,
      },
      {
        mode: "rail",
        route: { shortName: "S1" },
        tripId: "trip-1",
        headsign: "Wiesbaden",
        from: place("stop-a", "Hauptbahnhof", "3"),
        to: place("stop-d", "Messe"),
        startTime: "2026-08-09T08:10:00Z",
        endTime: "2026-08-09T08:40:00Z",
        scheduledStartTime: "2026-08-09T08:10:00Z",
        scheduledEndTime: "2026-08-09T08:40:00Z",
        durationSeconds: 1_800,
      },
      {
        mode: "walking",
        from: place("stop-d", "Messe"),
        to: place("destination", "Office"),
        startTime: "2026-08-09T08:40:00Z",
        endTime: "2026-08-09T08:45:00Z",
        durationSeconds: 300,
      },
    ],
  };
}

export function transitStartPackageFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: "transit" as const,
    itinerary: transitItineraryFixture(),
    captures: [
      {
        legIndex: 1,
        tripId: "trip-1",
        capturedAtMs: START,
        status: "captured" as const,
        stops: [
          { stopId: "stop-a", name: "Hauptbahnhof", lat: 50.11, lng: 8.68 },
          { stopId: "stop-b", name: "Galluswarte", lat: 50.11, lng: 8.66 },
          { stopId: "stop-c", name: "Messe West", lat: 50.11, lng: 8.65 },
          { stopId: "stop-d", name: "Messe", lat: 50.11, lng: 8.64 },
        ],
      },
    ],
    locale: "en" as const,
    units: "metric" as const,
    settings: { voiceEnabled: true, keepScreenOn: true, alightAlertsEnabled: true },
    itineraryFingerprint: FIXTURE_FINGERPRINT,
    ...overrides,
  };
}

export function transitSessionFixture(
  overrides: Partial<TransitMobileSession> = {},
): TransitMobileSession {
  return {
    schemaVersion: 1,
    sessionId: "session-t1",
    revision: 1,
    status: "active",
    startedAtMs: START,
    updatedAtMs: START,
    expiresAtMs: START + 60 * 60_000,
    locale: "en",
    units: "metric",
    connectivity: "online",
    permissionMode: "background",
    cueLedger: { spoken: [], events: [] },
    kind: "transit",
    payload: {
      startPackage: transitStartPackageFixture() as never,
      tickState: {
        currentLegIndex: 0,
        currentWalkStepIndex: 0,
        phase: "walking",
        legEnteredAtMs: START,
        spokenCueIds: [],
        emittedEventIds: [],
        scheduleFallback: "inactive",
      },
      progress: null,
      confidence: "gps",
      refreshToken: FIXTURE_TOKEN,
      refresh: { status: "ready", generation: 0, attempts: 0 },
      replan: { status: "idle", generation: 0, attempts: 0 },
      scheduledAlerts: [],
    },
    ...overrides,
  } as TransitMobileSession;
}
