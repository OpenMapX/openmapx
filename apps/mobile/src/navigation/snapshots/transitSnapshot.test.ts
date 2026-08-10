import type { TransitMobileSession } from "@openmapx/core/navigation";
import {
  FIXTURE_FINGERPRINT,
  FIXTURE_TOKEN,
  transitSessionFixture,
} from "../transit/testing/transitFixture";
import {
  TRANSIT_SNAPSHOT_VERSION,
  transitFullSnapshot,
  transitProgressSnapshot,
} from "./transitSnapshot";

function session(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  return transitSessionFixture({ revision: 6, ...overrides });
}

describe("transitFullSnapshot", () => {
  it("carries the identity and itinerary a page needs to render", () => {
    const snapshot = transitFullSnapshot(session());

    expect(snapshot.version).toBe(TRANSIT_SNAPSHOT_VERSION);
    expect(snapshot.type).toBe("full");
    expect(snapshot.sessionId).toBe("session-t1");
    expect(snapshot.revision).toBe(6);
    expect(snapshot.kind).toBe("transit");
    expect(snapshot.itineraryFingerprint).toBe(FIXTURE_FINGERPRINT);
    expect(snapshot.itinerary).toBeTruthy();
    expect(snapshot.captures).toBeTruthy();
  });

  it("carries the leg, phase and confidence the banner shows", () => {
    const snapshot = transitFullSnapshot(session());

    expect(snapshot.currentLegIndex).toBe(0);
    expect(snapshot.currentWalkStepIndex).toBe(0);
    expect(snapshot.phase).toBe("walking");
    expect(snapshot.confidence).toBe("gps");
  });

  describe("the rotating token", () => {
    it("never appears in a full snapshot", () => {
      expect(JSON.stringify(transitFullSnapshot(session()))).not.toContain(FIXTURE_TOKEN);
    });

    it("never appears in a progress snapshot", () => {
      expect(JSON.stringify(transitProgressSnapshot(session()))).not.toContain(FIXTURE_TOKEN);
    });

    it("is not leaked by a nested field the server added", () => {
      // Stripping is key-based, so a token the server moves somewhere new does
      // not start leaking the day it moves.
      const nested = session();
      (nested.payload.startPackage.itinerary as Record<string, unknown>).meta = {
        deep: { refreshToken: FIXTURE_TOKEN },
      };

      expect(JSON.stringify(transitFullSnapshot(nested))).not.toContain(FIXTURE_TOKEN);
    });

    it("is still reported as available, without its value", () => {
      // The page needs to know live data is possible; it has no use for the
      // value and no business holding it.
      expect(transitFullSnapshot(session()).liveStatus.hasLiveToken).toBe(true);
    });

    it("is reported as absent when there is none", () => {
      const noToken = session();
      noToken.payload.refreshToken = null;

      expect(transitFullSnapshot(noToken).liveStatus.hasLiveToken).toBe(false);
    });
  });

  it("reports whether the get-off backup is actually scheduled", () => {
    expect(transitFullSnapshot(session()).alightAlertAvailability).toBe("unavailable");

    const scheduled = session();
    scheduled.payload.scheduledAlerts = [{ id: "a1", legIndex: 1, triggerAtMs: 1 }];
    expect(transitFullSnapshot(scheduled).alightAlertAvailability).toBe("scheduled");
  });

  it("reports the backup as disabled when the rider turned it off", () => {
    const off = session();
    off.payload.startPackage.settings.alightAlertsEnabled = false;

    expect(transitFullSnapshot(off).alightAlertAvailability).toBe("disabled");
  });

  it("reports the live and replan state without their request identifiers", () => {
    const working = session();
    working.payload.refresh = {
      status: "in-flight",
      generation: 3,
      requestId: "r-secret",
      attempts: 0,
    };

    const snapshot = transitFullSnapshot(working);

    expect(snapshot.liveStatus.refresh).toBe("in-flight");
    expect(JSON.stringify(snapshot)).not.toContain("r-secret");
  });

  it("does not share mutable state with the session it projected", () => {
    const current = session();
    const snapshot = transitFullSnapshot(current);

    (snapshot.itinerary as { legs: unknown[] }).legs.push({});

    expect((current.payload.startPackage.itinerary as { legs: unknown[] }).legs).toHaveLength(3);
  });

  it("carries no engine internals the UI cannot use", () => {
    const serialised = JSON.stringify(transitFullSnapshot(session()));

    for (const internal of ["emittedEventIds", "spokenCueIds", "cueLedger", "scheduleFallback"]) {
      expect(serialised).not.toContain(internal);
    }
  });
});

describe("transitProgressSnapshot", () => {
  it("carries the identity a consumer needs to apply it safely", () => {
    const snapshot = transitProgressSnapshot(session());

    expect(snapshot.type).toBe("progress");
    expect(snapshot.sessionId).toBe("session-t1");
    expect(snapshot.revision).toBe(6);
    expect(snapshot.itineraryFingerprint).toBe(FIXTURE_FINGERPRINT);
  });

  it("carries only what changes while travelling", () => {
    const snapshot = transitProgressSnapshot(session()) as unknown as Record<string, unknown>;

    expect(Object.keys(snapshot).sort()).toEqual([
      "confidence",
      "connectivity",
      "currentLegIndex",
      "currentWalkStepIndex",
      "itineraryFingerprint",
      "liveStatus",
      "phase",
      "progress",
      "revision",
      "sessionId",
      "status",
      "type",
      "version",
    ]);
  });

  it("never carries the itinerary or the captures", () => {
    const snapshot = transitProgressSnapshot(session()) as unknown as Record<string, unknown>;

    expect(snapshot.itinerary).toBeUndefined();
    expect(snapshot.captures).toBeUndefined();
  });
});
