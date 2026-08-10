import { describe, expect, it } from "vitest";
import {
  appendToLedger,
  isMobileSessionExpired,
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  MOBILE_SESSION_LEDGER_LIMIT,
  migrateMobileSession,
  parseMobileSession,
  redactSessionForDiagnostics,
} from "./mobileSession";

const NOW = 1_700_000_000_000;
const SECRET_TOKEN = "rotating-refresh-token-xyz";

function line(index: number): [number, number] {
  return [8.6 + index / 100_000, 50.1 + index / 100_000];
}

function groundSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "ground",
    sessionId: "s-1",
    revision: 1,
    status: "active",
    startedAtMs: NOW,
    updatedAtMs: NOW,
    expiresAtMs: NOW + MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
    locale: "en",
    units: "metric",
    connectivity: "online",
    permissionMode: "background",
    cueLedger: { spoken: [], events: [] },
    payload: {
      startPackage: {
        kind: "ground",
        route: {
          distance: 100,
          duration: 60,
          geometry: [line(0), line(1)],
          steps: [],
          mode: "driving",
        },
        alternatives: [],
        mode: "driving",
        destinationWaypoints: [line(1)],
        routeSelectionIntent: "automatic",
        routeOptions: {},
        locale: "en",
        units: "metric",
        settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" },
      },
      tickState: { offRouteScore: 0, lastRerouteAtMs: null, rerouteBackoffMs: 0, spokenCues: [] },
      progress: null,
      weakGps: false,
      offRoute: false,
      coasting: false,
      currentSpeedLimit: null,
      reroute: { status: "idle", attempts: 0 },
    },
    ...overrides,
  };
}

function transitSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "transit",
    sessionId: "s-2",
    revision: 3,
    status: "active",
    startedAtMs: NOW,
    updatedAtMs: NOW + 1_000,
    expiresAtMs: NOW + MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
    locale: "de",
    units: "metric",
    connectivity: "offline",
    permissionMode: "background",
    cueLedger: { spoken: ["c1"], events: ["e1"] },
    payload: {
      startPackage: {
        kind: "transit",
        itinerary: { legs: [] },
        captures: [],
        locale: "de",
        units: "metric",
        settings: { voiceEnabled: true, keepScreenOn: false, alightAlertsEnabled: true },
        itineraryFingerprint: "fp-1",
      },
      tickState: {
        currentLegIndex: 0,
        currentWalkStepIndex: 0,
        phase: "walking",
        legEnteredAtMs: NOW,
        spokenCueIds: [],
        emittedEventIds: [],
        scheduleFallback: "inactive",
      },
      progress: null,
      confidence: "gps",
      refreshToken: SECRET_TOKEN,
      refresh: { status: "ready", generation: 1, attempts: 0 },
      replan: { status: "idle", generation: 1, attempts: 0 },
      scheduledAlerts: [],
    },
    ...overrides,
  };
}

describe("round trip", () => {
  it("accepts a ground session and keeps its discriminant", () => {
    const result = parseMobileSession(groundSession());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.kind).toBe("ground");
  });

  it("accepts a transit session and keeps its discriminant", () => {
    const result = parseMobileSession(transitSession());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.kind).toBe("transit");
  });

  it("parses a serialized session, as the repository stores it", () => {
    const result = parseMobileSession(JSON.stringify(groundSession()));
    expect(result.ok).toBe(true);
  });

  it("deep-copies mutable arrays so storage and caller cannot share state", () => {
    const source = groundSession({ cueLedger: { spoken: ["a"], events: [] } });
    const result = parseMobileSession(source);
    if (!result.ok) throw new Error("expected success");
    result.session.cueLedger.spoken.push("b");
    expect((source.cueLedger as { spoken: string[] }).spoken).toEqual(["a"]);
  });

  it("never mutates the input object", () => {
    const source = groundSession();
    const before = JSON.stringify(source);
    parseMobileSession(source);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("expiry", () => {
  it("expires exactly at expiresAtMs", () => {
    const result = parseMobileSession(groundSession());
    if (!result.ok) throw new Error("expected success");
    const { expiresAtMs } = result.session;
    expect(isMobileSessionExpired(result.session, expiresAtMs - 1)).toBe(false);
    expect(isMobileSessionExpired(result.session, expiresAtMs)).toBe(true);
  });

  it("rejects a lifetime beyond twenty-four hours", () => {
    const tooLong = groundSession({
      expiresAtMs: NOW + MOBILE_NAVIGATION_SESSION_MAX_AGE_MS + 1,
    });
    expect(parseMobileSession(tooLong).ok).toBe(false);
  });

  it("rejects an expiry that precedes the start", () => {
    expect(parseMobileSession(groundSession({ expiresAtMs: NOW - 1 })).ok).toBe(false);
  });
});

describe("corrupt and inconsistent records", () => {
  it("reports an unsupported schema version distinctly, so it can be quarantined", () => {
    const result = parseMobileSession(groundSession({ schemaVersion: 2 }));
    expect(result).toEqual({ ok: false, code: "unsupported-schema" });
  });

  it("treats a missing schema version as invalid rather than assuming version 1", () => {
    const { schemaVersion: _dropped, ...rest } = groundSession();
    expect(parseMobileSession(rest)).toEqual({ ok: false, code: "invalid-session" });
  });

  it("rejects updatedAtMs before startedAtMs", () => {
    expect(parseMobileSession(groundSession({ updatedAtMs: NOW - 1 })).ok).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(parseMobileSession(groundSession({ revision: -1 })).ok).toBe(false);
  });

  it("rejects a payload whose kind disagrees with the session", () => {
    const mismatched = groundSession();
    (mismatched as { kind: string }).kind = "transit";
    expect(parseMobileSession(mismatched).ok).toBe(false);
  });

  it("rejects duplicate cue ids in the ledger", () => {
    const duplicated = groundSession({ cueLedger: { spoken: ["c1", "c1"], events: [] } });
    expect(parseMobileSession(duplicated).ok).toBe(false);
  });

  it("rejects duplicate event ids in the ledger", () => {
    const duplicated = groundSession({ cueLedger: { spoken: [], events: ["e1", "e1"] } });
    expect(parseMobileSession(duplicated).ok).toBe(false);
  });

  it("rejects a refresh token on a ground session", () => {
    const ground = groundSession();
    (ground.payload as Record<string, unknown>).refreshToken = SECRET_TOKEN;
    expect(parseMobileSession(ground).ok).toBe(false);
  });

  it.each(["fixes", "history", "track", "positions", "breadcrumbs"])(
    "rejects the accumulating key %s, which would become a location history",
    (key) => {
      const withHistory = groundSession();
      (withHistory.payload as Record<string, unknown>)[key] = [[8.6, 50.1]];
      expect(parseMobileSession(withHistory).ok).toBe(false);
    },
  );

  it("rejects an out-of-range coordinate in the last accepted fix", () => {
    const bad = groundSession({
      lastAcceptedFix: { coords: [8.6, 91], accuracy: 5, timestampMs: NOW },
    });
    expect(parseMobileSession(bad).ok).toBe(false);
  });

  it.each([null, undefined, 42, "not json", "{}", []])("rejects %p", (value) => {
    expect(parseMobileSession(value).ok).toBe(false);
  });
});

describe("migrateMobileSession", () => {
  it("passes a current record through", () => {
    expect(migrateMobileSession(groundSession()).ok).toBe(true);
  });

  it("refuses a newer schema rather than guessing", () => {
    expect(migrateMobileSession(groundSession({ schemaVersion: 99 }))).toEqual({
      ok: false,
      code: "unsupported-schema",
    });
  });
});

describe("appendToLedger", () => {
  it("adds new ids and ignores repeats", () => {
    expect(appendToLedger(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("trims the oldest entries beyond the cap", () => {
    const full = Array.from({ length: MOBILE_SESSION_LEDGER_LIMIT }, (_, i) => `c${i}`);
    const next = appendToLedger(full, ["new"]);
    expect(next).toHaveLength(MOBILE_SESSION_LEDGER_LIMIT);
    expect(next.at(-1)).toBe("new");
    expect(next).not.toContain("c0");
  });

  it("does not mutate the source ledger", () => {
    const source = ["a"];
    appendToLedger(source, ["b"]);
    expect(source).toEqual(["a"]);
  });
});

describe("redactSessionForDiagnostics", () => {
  it("returns shape and counts only", () => {
    const result = parseMobileSession(transitSession());
    if (!result.ok) throw new Error("expected success");
    const redacted = redactSessionForDiagnostics(result.session, NOW + 5_000);
    expect(redacted).toEqual({
      kind: "transit",
      status: "active",
      revision: 3,
      ageMs: 5_000,
      connectivity: "offline",
      permissionMode: "background",
      spokenCueCount: 1,
      eventCount: 1,
      hasLastFix: false,
    });
  });

  it("leaks no token, coordinate, fingerprint or stop name", () => {
    const source = transitSession({
      lastAcceptedFix: { coords: [8.6, 50.1], accuracy: 5, timestampMs: NOW },
    });
    const result = parseMobileSession(source);
    if (!result.ok) throw new Error("expected success");
    const serialized = JSON.stringify(redactSessionForDiagnostics(result.session, NOW));
    for (const secret of [SECRET_TOKEN, "8.6", "50.1", "fp-1", "Hauptbahnhof"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports whether a last fix exists without revealing it", () => {
    const withFix = parseMobileSession(
      groundSession({ lastAcceptedFix: { coords: [8.6, 50.1], accuracy: 5, timestampMs: NOW } }),
    );
    if (!withFix.ok) throw new Error("expected success");
    expect(redactSessionForDiagnostics(withFix.session, NOW).hasLastFix).toBe(true);
  });
});

describe("the terminal acknowledgement", () => {
  it("is the only thing that may outlive a session", async () => {
    const { mobileTerminalAckSchema } = await import("./mobileSession");
    const ack = {
      sessionId: "s-1",
      kind: "transit" as const,
      finalStatus: "arrived" as const,
      finalRevision: 12,
      completedAtMs: NOW,
    };
    expect(mobileTerminalAckSchema.parse(ack)).toEqual(ack);
  });

  it.each(["payload", "lastAcceptedFix", "refreshToken", "route", "stopName", "cueText"])(
    "rejects the location-bearing field %s",
    async (field) => {
      const { mobileTerminalAckSchema } = await import("./mobileSession");
      expect(() =>
        mobileTerminalAckSchema.parse({
          sessionId: "s-1",
          kind: "ground",
          finalStatus: "stopped",
          finalRevision: 1,
          completedAtMs: NOW,
          [field]: "anything",
        }),
      ).toThrow();
    },
  );
});
