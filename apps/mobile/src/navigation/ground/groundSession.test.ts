import type { GroundNavigationStartPackage } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  announceMultiplierFor,
  createGroundPreparingSession,
  GROUND_MODES,
  type GroundMode,
  groundRouteFingerprint,
  locationProfileForMode,
  validateGroundStartPackage,
} from "./groundSession";

const NOW = 1_700_000_100_000;

function startPackage(
  overrides: Partial<GroundNavigationStartPackage> = {},
): GroundNavigationStartPackage {
  const base = groundSessionFixture().payload.startPackage;
  return { ...base, ...overrides } as GroundNavigationStartPackage;
}

function routeWith(overrides: Record<string, unknown>) {
  return { ...startPackage().route, ...overrides };
}

const IDENTITY = {
  sessionId: "session-1",
  locale: "en" as const,
  units: "metric" as const,
  permissionMode: "background" as const,
};

describe("validateGroundStartPackage", () => {
  it.each(GROUND_MODES)("accepts a well-formed %s package", (mode) => {
    const result = validateGroundStartPackage(
      startPackage({ mode, route: routeWith({ mode }) as never }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a mode the ground engine cannot guide", () => {
    for (const mode of ["transit", "ride", "flight", "teleport"]) {
      const result = validateGroundStartPackage(
        startPackage({ mode: mode as GroundMode, route: routeWith({ mode }) as never }),
      );

      // The wire schema already narrows the mode, so this is the schema's
      // refusal — what matters is that no unsupported mode reaches a session.
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a route whose own mode disagrees with the requested one", () => {
    const result = validateGroundStartPackage(
      startPackage({ mode: "driving", route: routeWith({ mode: "cycling" }) as never }),
    );

    expect(result).toEqual({ ok: false, code: "mode-mismatch" });
  });

  it("rejects a route that is not a line", () => {
    // Enforced by the shared schema, which every layer parses through, so the
    // adapter does not repeat the check.
    const result = validateGroundStartPackage(
      startPackage({ route: routeWith({ geometry: [[8.68, 50.11]] }) as never }),
    );

    expect(result).toEqual({ ok: false, code: "invalid-package" });
  });

  it("rejects a route with no steps to announce", () => {
    const result = validateGroundStartPackage(
      startPackage({ route: routeWith({ steps: [] }) as never }),
    );

    expect(result).toEqual({ ok: false, code: "missing-steps" });
  });

  it("rejects an alternative for a different mode", () => {
    const result = validateGroundStartPackage(
      startPackage({ alternatives: [routeWith({ mode: "walking" })] as never }),
    );

    expect(result).toEqual({ ok: false, code: "invalid-alternative" });
  });

  it("rejects an alternative that is not a line", () => {
    const result = validateGroundStartPackage(
      startPackage({ alternatives: [routeWith({ geometry: [[8.68, 50.11]] })] as never }),
    );

    expect(result).toEqual({ ok: false, code: "invalid-package" });
  });

  it("rejects a package with no destination", () => {
    expect(validateGroundStartPackage(startPackage({ destinationWaypoints: [] })).ok).toBe(false);
  });

  it("rejects far too many waypoints", () => {
    const many = Array.from({ length: 200 }, () => [8.68, 50.11] as [number, number]);

    expect(validateGroundStartPackage(startPackage({ destinationWaypoints: many })).ok).toBe(false);
  });

  it("rejects captured speed limits that do not line up with the segments", () => {
    // Two geometry points is one segment; three limits describe a different road.
    const result = validateGroundStartPackage(
      startPackage({ capturedLiveSpeedLimits: [50, 50, 50] }),
    );

    expect(result).toEqual({ ok: false, code: "speed-limit-length-mismatch" });
  });

  it("accepts captured speed limits of exactly the segment count", () => {
    expect(validateGroundStartPackage(startPackage({ capturedLiveSpeedLimits: [50] })).ok).toBe(
      true,
    );
  });

  it.each([
    ["a missing package", undefined],
    ["a non-object", "route"],
    ["an empty object", {}],
    ["an unknown extra field", { ...startPackage(), sneaky: true }],
  ])("rejects %s", (_label, value) => {
    expect(validateGroundStartPackage(value)).toEqual({ ok: false, code: "invalid-package" });
  });

  it.each([
    ["an unsupported locale", { locale: "fr" }],
    ["an unsupported unit", { units: "furlongs" }],
    ["an unsupported voice timing", { settings: { ...startPackage().settings, voiceTiming: "x" } }],
    ["an unsupported selection intent", { routeSelectionIntent: "guessed" }],
  ])("rejects %s", (_label, overrides) => {
    expect(validateGroundStartPackage({ ...startPackage(), ...overrides }).ok).toBe(false);
  });
});

describe("createGroundPreparingSession", () => {
  it("starts at revision 1, preparing, with a deterministic engine state", () => {
    const session = createGroundPreparingSession(startPackage(), IDENTITY, NOW);

    expect(session.revision).toBe(1);
    expect(session.status).toBe("preparing");
    expect(session.kind).toBe("ground");
    expect(session.payload.tickState).toEqual({
      offRouteScore: 0,
      lastRerouteAtMs: null,
      rerouteBackoffMs: 0,
      spokenCues: [],
    });
  });

  it("has no progress, no last fix and no pending reroute", () => {
    const session = createGroundPreparingSession(startPackage(), IDENTITY, NOW);

    expect(session.payload.progress).toBeNull();
    expect(session.lastAcceptedFix).toBeUndefined();
    expect(session.payload.reroute).toEqual({ status: "idle", attempts: 0 });
    expect(session.payload.coasting).toBe(false);
    expect(session.payload.offRoute).toBe(false);
    expect(session.payload.weakGps).toBe(false);
    expect(session.payload.currentSpeedLimit).toBeNull();
  });

  it("has empty cue and event ledgers", () => {
    const session = createGroundPreparingSession(startPackage(), IDENTITY, NOW);

    expect(session.cueLedger).toEqual({ spoken: [], events: [] });
  });

  it("expires exactly at the shared maximum age", () => {
    const session = createGroundPreparingSession(startPackage(), IDENTITY, NOW);

    expect(session.startedAtMs).toBe(NOW);
    expect(session.expiresAtMs - session.startedAtMs).toBe(24 * 60 * 60 * 1000);
  });

  it("carries the identity it was given", () => {
    const session = createGroundPreparingSession(
      startPackage(),
      { ...IDENTITY, locale: "de", units: "imperial", permissionMode: "foreground-only" },
      NOW,
    );

    expect(session.locale).toBe("de");
    expect(session.units).toBe("imperial");
    expect(session.permissionMode).toBe("foreground-only");
  });

  it("identifies the route it is following", () => {
    const session = createGroundPreparingSession(startPackage(), IDENTITY, NOW);

    expect(groundRouteFingerprint(session)).toEqual(expect.any(String));
    expect(groundRouteFingerprint(session).length).toBeGreaterThan(0);
  });

  it("does not share mutable state with the package it was built from", () => {
    const source = startPackage();
    const session = createGroundPreparingSession(source, IDENTITY, NOW);

    source.route.geometry.push([9.99, 49.99]);
    source.destinationWaypoints.push([9.99, 49.99]);

    expect(session.payload.startPackage.route.geometry).toHaveLength(2);
    expect(session.payload.startPackage.destinationWaypoints).toHaveLength(1);
  });
});

describe("announceMultiplierFor", () => {
  it("maps each setting to a pinned multiplier", () => {
    expect(announceMultiplierFor("early")).toBe(1.35);
    expect(announceMultiplierFor("normal")).toBe(1);
    expect(announceMultiplierFor("late")).toBe(0.75);
  });

  it("puts early cues before normal, and normal before late", () => {
    expect(announceMultiplierFor("early")).toBeGreaterThan(announceMultiplierFor("normal"));
    expect(announceMultiplierFor("normal")).toBeGreaterThan(announceMultiplierFor("late"));
  });
});

describe("locationProfileForMode", () => {
  it.each([
    ["driving", "driving"],
    ["motorcycle", "motorcycle"],
    ["cycling", "cycling"],
    ["walking", "walking"],
  ] as Array<[GroundMode, string]>)("asks for the %s cadence", (mode, expected) => {
    expect(locationProfileForMode(mode)).toBe(expected);
  });

  it("covers every ground mode", () => {
    for (const mode of GROUND_MODES) expect(locationProfileForMode(mode)).toBeTruthy();
  });
});
