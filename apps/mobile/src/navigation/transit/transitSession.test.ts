import type { TransitMobileSession } from "@openmapx/core/navigation";
import {
  FIXTURE_TOKEN,
  transitSessionFixture,
  transitStartPackageFixture,
} from "./testing/transitFixture";
import {
  createTransitPreparingSession,
  NEAR_EVENT_SECONDS,
  transitProfileFor,
  transitProfileForTime,
  validateTransitStartPackage,
} from "./transitSession";

const NOW = 1_700_000_100_000;
const IDENTITY = { sessionId: "session-t1", permissionMode: "background" as const };

describe("validateTransitStartPackage", () => {
  it("accepts a well-formed captured package", () => {
    expect(validateTransitStartPackage(transitStartPackageFixture()).ok).toBe(true);
  });

  it("refuses an itinerary with nowhere to go", () => {
    const empty = transitStartPackageFixture({ itinerary: { legs: [] } });

    expect(validateTransitStartPackage(empty)).toEqual({ ok: false, code: "no-destination" });
  });

  it("refuses a trip that never boards anything", () => {
    const walkOnly = transitStartPackageFixture({
      itinerary: {
        legs: [
          {
            mode: "walking",
            from: { stopId: "a", name: "A", lat: 50.11, lng: 8.68 },
            to: { stopId: "b", name: "B", lat: 50.12, lng: 8.69 },
          },
        ],
      },
      captures: [],
    });

    expect(validateTransitStartPackage(walkOnly)).toEqual({ ok: false, code: "no-transit-leg" });
  });

  it("refuses a capture pointing at a leg that does not exist", () => {
    // Counting down the wrong train's stops is worse than counting none.
    const mismatched = transitStartPackageFixture({
      captures: [
        { legIndex: 9, tripId: "trip-1", capturedAtMs: NOW, status: "captured", stops: [] },
      ],
    });

    expect(validateTransitStartPackage(mismatched)).toEqual({
      ok: false,
      code: "capture-leg-mismatch",
    });
  });

  it.each([
    ["nothing", undefined],
    ["a string", "itinerary"],
    ["an empty object", {}],
    ["an unknown field", { ...transitStartPackageFixture(), sneaky: true }],
    ["an unsupported locale", { ...transitStartPackageFixture(), locale: "fr" }],
  ])("refuses %s", (_label, value) => {
    expect(validateTransitStartPackage(value)).toEqual({ ok: false, code: "invalid-package" });
  });
});

describe("createTransitPreparingSession", () => {
  const build = () =>
    createTransitPreparingSession(transitStartPackageFixture() as never, IDENTITY, NOW);

  it("starts at revision 1, preparing, on the first leg", () => {
    const session = build();

    expect(session.revision).toBe(1);
    expect(session.status).toBe("preparing");
    expect(session.kind).toBe("transit");
    expect(session.payload.tickState.currentLegIndex).toBe(0);
    expect(session.payload.tickState.phase).toBe("walking");
  });

  it("has no progress, no alerts and a fresh tick state", () => {
    const session = build();

    expect(session.payload.progress).toBeNull();
    expect(session.payload.scheduledAlerts).toEqual([]);
    expect(session.payload.tickState.spokenCueIds).toEqual([]);
    expect(session.payload.tickState.emittedEventIds).toEqual([]);
  });

  it("takes the rotating token into native authority", () => {
    const session = build();

    expect(session.payload.refreshToken).toBe(FIXTURE_TOKEN);
    expect(session.payload.refresh.status).toBe("ready");
  });

  it("marks the refresh chain broken when there is no token to rotate", () => {
    const noToken = transitStartPackageFixture({
      itinerary: { ...transitStartPackageFixture().itinerary, refreshToken: undefined },
    });

    const session = createTransitPreparingSession(noToken as never, IDENTITY, NOW);

    expect(session.payload.refreshToken).toBeNull();
    expect(session.payload.refresh.status).toBe("broken");
  });

  it("keeps the captures the package was built with", () => {
    expect(build().payload.startPackage.captures).toHaveLength(1);
  });

  it("expires at the shared maximum age", () => {
    expect(build().expiresAtMs - build().startedAtMs).toBe(24 * 60 * 60 * 1000);
  });

  it("does not share mutable state with the package it was built from", () => {
    const source = transitStartPackageFixture();
    const session = createTransitPreparingSession(source as never, IDENTITY, NOW);

    source.captures[0].stops.push({ stopId: "x", name: "X", lat: 0, lng: 0 });

    expect(session.payload.startPackage.captures[0].stops).toHaveLength(4);
  });
});

describe("transitProfileFor", () => {
  function withPhase(phase: string, overrides: Record<string, unknown> = {}) {
    const base = transitSessionFixture();
    return {
      ...base,
      payload: {
        ...base.payload,
        tickState: { ...base.payload.tickState, phase, ...overrides },
      },
    } as TransitMobileSession;
  }

  it.each([
    ["walking", "walking"],
    ["transferring", "walking"],
    ["waiting-to-board", "transit-near-event"],
  ] as const)("asks for the %s cadence", (phase, expected) => {
    expect(transitProfileFor(withPhase(phase))).toBe(expected);
  });

  it("drops to a cruising cadence while riding with stops still ahead", () => {
    // An hour of high-rate updates for a banner nobody is watching is an hour of
    // battery spent for nothing.
    expect(transitProfileFor(withPhase("riding", { currentLegIndex: 1 }))).toBe("transit-cruise");
  });

  it("returns to a near-event cadence with two stops remaining", () => {
    const base = transitSessionFixture();
    const session = {
      ...base,
      payload: {
        ...base.payload,
        tickState: { ...base.payload.tickState, phase: "riding", currentLegIndex: 1 },
        startPackage: {
          ...base.payload.startPackage,
          captures: [
            {
              ...base.payload.startPackage.captures[0],
              stops: base.payload.startPackage.captures[0].stops.map((stop, index) => ({
                ...stop,
                departed: index < 2,
              })),
            },
          ],
        },
      },
    } as TransitMobileSession;

    expect(transitProfileFor(session)).toBe("transit-near-event");
  });
});

describe("transitProfileForTime", () => {
  function riding() {
    const base = transitSessionFixture();
    return {
      ...base,
      payload: {
        ...base.payload,
        tickState: { ...base.payload.tickState, phase: "riding", currentLegIndex: 1 },
      },
    } as TransitMobileSession;
  }

  const legEndsAtMs = new Date("2026-08-09T08:40:00Z").getTime();

  it("cruises while the alighting stop is far off in time", () => {
    expect(transitProfileForTime(riding(), legEndsAtMs - 30 * 60_000)).toBe("transit-cruise");
  });

  it("raises the cadence as the alighting stop approaches", () => {
    expect(transitProfileForTime(riding(), legEndsAtMs - (NEAR_EVENT_SECONDS - 10) * 1_000)).toBe(
      "transit-near-event",
    );
  });

  it("does not override a phase that already asks for more", () => {
    expect(transitProfileForTime(transitSessionFixture(), legEndsAtMs)).toBe("walking");
  });
});
