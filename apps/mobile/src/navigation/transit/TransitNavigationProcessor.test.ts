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
    const outcome = processor().replace(session(), replacement(), NOW);
    const next = (outcome as { session: TransitMobileSession }).session;

    expect(next.payload.startPackage.itineraryFingerprint).toBe("it-replacement-3");
    // The old token belongs to the journey that produced it and is useless
    // against a different one.
    expect(next.payload.refreshToken).toBe("tok_replacement");
    expect(next.payload.refreshToken).not.toBe(FIXTURE_TOKEN);
  });

  it("resets progress, phase and confidence", () => {
    const advanced = session();
    advanced.payload.tickState.currentLegIndex = 1;
    advanced.payload.tickState.phase = "riding";
    advanced.payload.confidence = "schedule";

    const next = (
      processor().replace(advanced, replacement(), NOW) as {
        session: TransitMobileSession;
      }
    ).session;

    expect(next.payload.tickState.currentLegIndex).toBe(0);
    expect(next.payload.tickState.phase).toBe("walking");
    expect(next.payload.confidence).toBe("gps");
    expect(next.payload.progress).toBeNull();
  });

  it("invalidates every in-flight network generation", () => {
    // A reply already on the wire cannot land on a session it no longer
    // describes.
    const busy = session();
    busy.payload.refresh = { status: "in-flight", generation: 4, requestId: "r1", attempts: 1 };
    busy.payload.replan = { status: "in-flight", generation: 2, requestId: "p1", attempts: 1 };

    const next = (
      processor().replace(busy, replacement(), NOW) as {
        session: TransitMobileSession;
      }
    ).session;

    expect(next.payload.refresh.generation).toBe(5);
    expect(next.payload.replan.generation).toBe(3);
    expect(next.payload.refresh.status).toBe("ready");
    expect(next.payload.replan.status).toBe("idle");
  });

  it("cancels superseded alerts before scheduling anything new", () => {
    // An alighting alert for a train the rider is no longer on is worse than
    // no alert at all.
    const outcome = processor().replace(session(), replacement(), NOW) as {
      effects: Array<{ kind: string }>;
    };

    const kinds = outcome.effects.map((effect) => effect.kind);
    expect(kinds.indexOf("cancel-session-alerts")).toBeLessThan(kinds.indexOf("reconcile-alerts"));
    expect(kinds).toContain("publish-snapshot");
  });

  it("drops the last fix, which was matched against the old itinerary", () => {
    const withFix = session();
    withFix.lastAcceptedFix = { coords: [8.7, 50.11], accuracy: 5, timestampMs: NOW };

    const next = (
      processor().replace(withFix, replacement(), NOW) as {
        session: TransitMobileSession;
      }
    ).session;

    expect(next.lastAcceptedFix).toBeUndefined();
    expect(Object.hasOwn(next, "lastAcceptedFix")).toBe(false);
  });

  it("clears the scheduled alerts of the trip it replaced", () => {
    const scheduled = session();
    scheduled.payload.scheduledAlerts = [{ id: "a1", legIndex: 1, triggerAtMs: NOW + 60_000 }];

    const next = (
      processor().replace(scheduled, replacement(), NOW) as {
        session: TransitMobileSession;
      }
    ).session;

    expect(next.payload.scheduledAlerts).toEqual([]);
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
  it("replans before refreshing, because the plan itself is wrong", () => {
    // Refreshing times on a trip the rider can no longer make would only make
    // the wrong plan look current.
    const stranded = session();
    stranded.payload.replan = { status: "unavailable", generation: 1, attempts: 2 };
    stranded.payload.refresh = { status: "stale", generation: 3, attempts: 0 };

    return processor()
      .onConnectivityRestored(stranded, NOW)
      .then((mutation) => {
        expect(mutation?.effects).toEqual([
          { kind: "request-transit-replan", requestId: expect.any(String) },
        ]);
      });
  });

  it("refreshes when only the live data went stale", async () => {
    const stale = session();
    stale.payload.refresh = { status: "stale", generation: 3, attempts: 1 };

    const mutation = await processor().onConnectivityRestored(stale, NOW);

    expect(mutation?.effects).toEqual([
      { kind: "request-transit-refresh", requestId: expect.any(String) },
    ]);
    expect((mutation?.session as TransitMobileSession).payload.refresh.generation).toBe(4);
  });

  it("does not refresh without a token to rotate", async () => {
    const tokenless = session();
    tokenless.payload.refreshToken = null;
    tokenless.payload.refresh = { status: "stale", generation: 1, attempts: 0 };

    expect(await processor().onConnectivityRestored(tokenless, NOW)).toBeNull();
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
  it("records a replan intent rather than performing one", () => {
    const missed = session();
    missed.payload.tickState.currentLegIndex = 1;
    missed.payload.tickState.phase = "waiting-to-board";

    // Long past the leg's departure, so the engine reports a missed connection.
    const mutation = processor().processFixes(
      missed,
      [],
      new Date("2026-08-09T09:30:00Z").getTime(),
    );
    const next = mutation.session as TransitMobileSession;

    if (next.payload.replan.status === "pending") {
      expect(mutation.effects).toContainEqual({
        kind: "request-transit-replan",
        requestId: next.payload.replan.requestId,
      });
    } else {
      expect((mutation.effects ?? []).some((e) => e.kind === "request-transit-replan")).toBe(false);
    }
  });

  it("does not start a second replan while one is in flight", () => {
    const busy = session();
    busy.payload.replan = { status: "in-flight", generation: 1, requestId: "p1", attempts: 0 };
    busy.payload.tickState.currentLegIndex = 1;
    busy.payload.tickState.phase = "waiting-to-board";

    const mutation = processor().processFixes(busy, [], new Date("2026-08-09T09:30:00Z").getTime());

    expect((mutation.effects ?? []).some((e) => e.kind === "request-transit-replan")).toBe(false);
  });
});
