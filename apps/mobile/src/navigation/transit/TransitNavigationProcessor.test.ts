import type { TransitMobileSession } from "@openmapx/core/navigation";
import { TransitNavigationProcessor } from "./TransitNavigationProcessor";
import {
  FIXTURE_TOKEN,
  transitSessionFixture,
  transitStartPackageFixture,
} from "./testing/transitFixture";

const NOW = new Date("2026-08-09T08:05:00Z").getTime();

function session(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  return transitSessionFixture({
    startedAtMs: NOW - 5 * 60_000,
    updatedAtMs: NOW,
    expiresAtMs: NOW + 12 * 60 * 60_000,
    ...overrides,
  });
}

const processor = () => new TransitNavigationProcessor();

describe("TransitNavigationProcessor.prepare", () => {
  it("prepares a valid captured package", () => {
    const result = processor().prepare(transitStartPackageFixture() as never, {
      sessionId: "session-t1",
      nowMs: NOW,
      permissionMode: "background",
    });

    expect(result.ok).toBe(true);
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

    expect(
      processor().prepare(walkOnly as never, {
        sessionId: "s",
        nowMs: NOW,
        permissionMode: "background",
      }),
    ).toEqual({ ok: false, code: "no-transit-leg" });
  });
});

describe("TransitNavigationProcessor.replace", () => {
  const replacement = () =>
    transitStartPackageFixture({
      itineraryFingerprint: "it-replacement-3",
      itinerary: { ...transitStartPackageFixture().itinerary, refreshToken: "tok_replacement" },
    });

  it("adopts the new itinerary and its own token", () => {
    const previous = session();
    previous.payload.tickState.currentLegIndex = 1;
    previous.payload.tickState.phase = "riding";
    previous.payload.confidence = "schedule";
    previous.payload.progress = { currentLegIndex: 1, stale: true };
    previous.payload.refresh = { status: "in-flight", generation: 4, requestId: "r1", attempts: 1 };
    previous.lastAcceptedFix = { coords: [8.7, 50.11], accuracy: 5, timestampMs: NOW };
    previous.payload.scheduledAlerts = [{ id: "a1", legIndex: 1, triggerAtMs: NOW + 60_000 }];
    const outcome = processor().replace(previous, replacement(), NOW);
    const next = (outcome as { session: TransitMobileSession }).session;

    expect(next.payload.startPackage.itineraryFingerprint).toBe("it-replacement-3");
    // The old token belongs to the journey that produced it and is useless
    // against a different one.
    expect(next.payload.refreshToken).toBe("tok_replacement");
    expect(next.payload.refreshToken).not.toBe(FIXTURE_TOKEN);
    expect(next.payload.tickState.currentLegIndex).toBe(0);
    expect(next.payload.tickState.phase).toBe("walking");
    expect(next.payload.confidence).toBe("gps");
    expect(next.payload.progress).toBeNull();
    expect(next.payload.refresh).toMatchObject({ generation: 5, status: "ready" });
    expect(Object.hasOwn(next, "lastAcceptedFix")).toBe(false);
    expect(next.payload.scheduledAlerts).toEqual([]);
  });

  it("cancels superseded alerts before scheduling anything new", () => {
    // An alighting alert for a train the rider is no longer on is worse than
    // no alert at all.
    const outcome = processor().replace(session(), replacement(), NOW) as {
      effects: Array<{ kind: string }>;
    };

    const kinds = outcome.effects.map((effect) => effect.kind);
    expect(kinds.indexOf("cancel-session-alerts")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("reconcile-alerts")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("cancel-session-alerts")).toBeLessThan(kinds.indexOf("reconcile-alerts"));
    expect(kinds).toContain("publish-snapshot");
  });

  it.each(["arrived", "stopped", "expired", "error"] as const)(
    "refuses a replacement after a %s session",
    (status) => {
      expect(processor().replace(session({ status }), replacement(), NOW)).toEqual({
        ok: false,
        code: "not-active",
      });
    },
  );

  it.each([
    ["nothing", undefined],
    ["a partial itinerary", { kind: "transit" }],
    ["a token-only update", { refreshToken: "tok_new" }],
  ])("refuses %s", (_label, value) => {
    expect(processor().replace(session(), value, NOW)).toEqual({
      ok: false,
      code: "invalid-package",
    });
  });
});

describe("TransitNavigationProcessor.onConnectivityRestored", () => {
  it("refreshes when only the live data went stale", async () => {
    const stale = session();
    stale.payload.refresh = { status: "stale", generation: 3, attempts: 1 };

    const mutation = await processor().onConnectivityRestored(stale, NOW);

    expect(mutation?.effects).toEqual([
      { kind: "request-transit-refresh", requestId: expect.any(String) },
    ]);
    expect((mutation?.session as TransitMobileSession).payload.refresh.generation).toBe(4);
  });

  it("refreshes captured journeys after reconnecting without an itinerary token", async () => {
    const tokenless = session();
    tokenless.payload.refreshToken = null;
    tokenless.payload.refresh = { status: "stale", generation: 1, attempts: 0 };

    expect((await processor().onConnectivityRestored(tokenless, NOW))?.effects).toEqual([
      { kind: "request-transit-refresh", requestId: expect.any(String) },
    ]);
  });

  it.each(["ready", "in-flight", "broken"] as const)(
    "does nothing on reconnect when refresh is %s",
    async (status) => {
      const current = session();
      current.payload.refresh = { status, generation: 1, attempts: 0 };

      expect(await processor().onConnectivityRestored(current, NOW)).toBeNull();
    },
  );

  it("records connectivity as online on the committed revision", async () => {
    const stale = session({ connectivity: "offline" });
    stale.payload.refresh = { status: "stale", generation: 1, attempts: 0 };

    const mutation = await processor().onConnectivityRestored(stale, NOW);

    expect(mutation?.session.connectivity).toBe("online");
    expect(mutation?.session.revision).toBe(stale.revision + 1);
  });
});

describe("TransitNavigationProcessor.processFixes", () => {
  it("keeps the selected journey after a departure timeout", () => {
    const missed = session();
    missed.payload.tickState.currentLegIndex = 1;
    missed.payload.tickState.phase = "waiting-to-board";
    const mutation = processor().processFixes(
      missed,
      [],
      new Date("2026-08-09T09:30:00Z").getTime(),
    );
    expect(
      (mutation.session as TransitMobileSession).payload.startPackage.itineraryFingerprint,
    ).toBe(missed.payload.startPackage.itineraryFingerprint);
    expect((mutation.session as TransitMobileSession).payload.tickState.phase).toBe(
      "waiting-to-board",
    );
    expect((mutation.effects ?? []).every((e) => e.kind !== "request-reroute")).toBe(true);
  });
});

it("keeps hosted sessions parseable across repeated capture timeouts", () => {
  const { parseMobileSession } = require("@openmapx/core/navigation");
  const p = processor();
  let current = session();
  current.payload.refreshToken = null;
  current.payload.refresh = { status: "broken", generation: 0, attempts: 3, ambiguousAttempts: 3 };
  for (let i = 0; i < 80; i++) {
    const at = NOW + i * 400_000;
    current = p.processFixes(current, [], at).session as TransitMobileSession;
    expect(current.payload.refresh.status).toBe("in-flight");
    current = p.processFixes(current, [], at + 21_000).session as TransitMobileSession;
    expect(parseMobileSession(JSON.stringify(current)).ok).toBe(true);
  }
});
it("does not poll completed captures on the final walking leg", async () => {
  const current = session();
  current.payload.refreshToken = null;
  current.payload.tickState.currentLegIndex = 2;
  current.payload.refresh = { status: "stale", generation: 0, attempts: 0 };
  expect(
    processor()
      .processFixes(current, [], NOW)
      .effects?.some((e) => e.kind === "request-transit-refresh"),
  ).toBe(false);
  expect(await processor().onConnectivityRestored(current, NOW)).toBeNull();
});
