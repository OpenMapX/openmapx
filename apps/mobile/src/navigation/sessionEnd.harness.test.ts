import {
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  TRANSIT_UNDO_WINDOW_MS,
} from "@openmapx/core/navigation";
import { CONNECTIVITY_DEBOUNCE_MS } from "../connectivity/ConnectivityDriver";
import { PREPARING_GRACE_MS } from "../lifecycle/NavigationRecoveryController";
import { ARRIVAL_CUE_GRACE_MS } from "./arrival";
import {
  createFakePhone,
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
} from "./testing/foregroundHarness";
import {
  FIXTURE_FINGERPRINT,
  transitItineraryFixture,
  transitStartPackageFixture,
} from "./transit/testing/transitFixture";

/**
 * A session ends in one place. Whoever ends it (the page, the trip card, the
 * recovery screen, its lifetime), the page, the shell state and keep-awake
 * each hear about it exactly once.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

function stoppedMessages() {
  return harness.sent.filter((message) => message.type === "session.stopped");
}

describe("one notice per end", () => {
  it("answers the page's End once and tells the shell once", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 3);
    expect(harness.phone.keepAwake.held).toBe(true);

    await harness.command("session.stop", {}, { sessionId });
    await harness.command("session.stop", {}, { sessionId });

    expect(stoppedMessages().map((message) => message.forMessageId !== undefined)).toEqual([
      true,
      true,
    ]);
    expect(harness.sessionEnds).toEqual([
      { sessionId, finalStatus: "stopped", revision: expect.any(Number) },
    ]);
    expect(harness.phone.keepAwake.held).toBe(false);
    expect(harness.phone.location.running).toBe(false);
  });

  it("tells the page about an end it did not ask for, once", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());

    expect(await harness.navigation.coordinator.stopNatively(sessionId)).toBe(true);
    expect(await harness.navigation.coordinator.stopNatively(sessionId)).toBe(false);
    await harness.settle();

    expect(stoppedMessages()).toEqual([
      {
        type: "session.stopped",
        payload: { sessionId, finalStatus: "stopped", revision: expect.any(Number) },
        sessionId,
      },
    ]);
    expect(harness.sessionEnds).toHaveLength(1);
    expect(harness.phone.keepAwake.held).toBe(false);
  });

  it("ends an expired trip on the next batch with one notice", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());

    harness.phone.clock.advance(MOBILE_NAVIGATION_SESSION_MAX_AGE_MS);
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[1])]);
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[2])]);

    expect(stoppedMessages()).toHaveLength(1);
    expect(stoppedMessages()[0].payload).toMatchObject({ sessionId, finalStatus: "expired" });
    expect(harness.sessionEnds).toEqual([expect.objectContaining({ finalStatus: "expired" })]);
    expect(harness.phone.location.running).toBe(false);
  });

  it("ends a trip from the recovery screen through the same path", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());

    expect(await harness.navigation.recovery.end()).toBe("session-ended");
    await harness.settle();

    expect(stoppedMessages()).toEqual([expect.objectContaining({ sessionId })]);
    expect(harness.sessionEnds).toHaveLength(1);
    expect(await harness.session()).toBeNull();
  });

  it("reports guidance stopping at an arrival without reporting an end", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);

    expect(harness.navigatingReports).toEqual([true, false]);
    expect(harness.sessionEnds).toEqual([]);
  });
});

describe("opening the app inside an arrival's release window", () => {
  function rideToTheEnd() {
    const itinerary = transitItineraryFixture();
    return transitStartPackageFixture({
      itinerary: {
        ...itinerary,
        endTime: itinerary.legs[1].endTime,
        legs: itinerary.legs.slice(0, 2),
      },
    });
  }

  async function alightAtTheEnd() {
    const trip = await harness.start(rideToTheEnd());
    for (const [type, expectedPhase] of [
      ["board", "walking"],
      ["alight", "riding"],
    ] as const) {
      await harness.command(
        "transit.action",
        {
          actionId: `${type}-1`,
          itineraryFingerprint: FIXTURE_FINGERPRINT,
          expectedPhase,
          type,
          legIndex: 1,
        },
        { sessionId: trip.sessionId },
      );
      harness.phone.clock.advance(1_000);
    }
    expect((await harness.session())?.status).toBe("arrived");
    return trip;
  }

  it("keeps the trip and its undo, and still releases location when the window closes", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await alightAtTheEnd();
    await harness.setVisible(false);
    await harness.elapse(60_000);

    await harness.setVisible(true);

    expect((await harness.session())?.status).toBe("arrived");
    expect(harness.phone.location.running).toBe(true);
    expect(harness.recoveryEvents.at(-1)).toBe("session-ended");
    expect(stoppedMessages()).toEqual([]);
    expect(harness.sessionEnds).toEqual([]);

    await harness.elapse(TRANSIT_UNDO_WINDOW_MS - 60_000 - 1_000);
    expect(harness.phone.location.running).toBe(true);
    await harness.elapse(2_000);
    expect(harness.phone.location.running).toBe(false);
    expect((await harness.session())?.sessionId).toBe(sessionId);
  });

  it("lets an undo made after the app was opened resume a tracked trip", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await alightAtTheEnd();
    await harness.setVisible(false);
    await harness.setVisible(true);

    const reply = await harness.command(
      "transit.action",
      {
        actionId: "undo-1",
        itineraryFingerprint: FIXTURE_FINGERPRINT,
        expectedPhase: "arrived",
        type: "undo",
        legIndex: 1,
      },
      { sessionId },
    );

    expect(reply?.type).toBe("snapshot.update");
    expect((await harness.session())?.status).toBe("active");
    expect(harness.phone.location.running).toBe(true);
  });

  it("keeps the arrival for the page when the app is opened after the window", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await alightAtTheEnd();
    await harness.setVisible(false);
    // Paused timers, so recovery is what releases location here.
    harness.phone.clock.timersPaused = true;
    await harness.elapse(TRANSIT_UNDO_WINDOW_MS + 1_000);
    expect(harness.phone.location.running).toBe(true);

    await harness.setVisible(true);

    expect(await harness.session()).toMatchObject({ sessionId, status: "arrived" });
    expect(harness.phone.location.running).toBe(false);
    expect(stoppedMessages()).toEqual([]);
    expect(harness.sessionEnds).toEqual([]);

    // The page's "Done" ends it, with the reply as its one notice.
    const done = await harness.command("session.complete", {}, { sessionId });
    expect(done).toMatchObject({ type: "session.stopped", payload: { finalStatus: "arrived" } });
    expect(harness.sessionEnds).toHaveLength(1);
  });

  it("keeps a road arrival card when the user switches apps after the grace", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);
    await harness.setVisible(false);
    await harness.elapse(20_000);

    await harness.setVisible(true);

    expect(await harness.session()).toMatchObject({ sessionId, status: "arrived" });
    expect(harness.phone.location.running).toBe(false);
    expect(stoppedMessages()).toEqual([]);
    expect(harness.sessionEnds).toEqual([]);
  });

  it("keeps a road arrival through its announcement grace after the process died", async () => {
    harness = await startForegroundHarness({ phone: createFakePhone() });
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);
    expect((await harness.session())?.status).toBe("arrived");

    harness = await harness.relaunch();
    await harness.setVisible(true);

    expect((await harness.session())?.status).toBe("arrived");
    expect(harness.phone.location.running).toBe(true);
    await harness.elapse(ARRIVAL_CUE_GRACE_MS);
    expect(harness.phone.location.running).toBe(false);
  });
});

describe("a recovery hold on the shell", () => {
  async function resumeRequiredAfterRestart() {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);
    // The system stopped location with the process, so the trip needs Resume.
    harness.phone.location.running = false;
    harness = await harness.relaunch();
    await harness.setVisible(true);
    expect(harness.recoveryEvents.at(-1)).toBe("resume-required");
    return sessionId;
  }

  it("keeps the Resume offer through a commit that is not a resume", async () => {
    await resumeRequiredAfterRestart();

    harness.phone.connectivity.set("offline");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);

    expect((await harness.session())?.connectivity).toBe("offline");
    expect(harness.navigatingReports).toEqual([]);
  });

  it("reports guidance again once the user resumes", async () => {
    await resumeRequiredAfterRestart();

    expect(await harness.navigation.recovery.resume()).toBe("session-started");
    harness.phone.connectivity.set("offline");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);

    expect(harness.phone.location.running).toBe(true);
    // Resume is dispatched by the shell itself; the arrival is the next change.
    expect(harness.navigatingReports).toEqual([false]);
  });
});

describe("a trip between prepare and start", () => {
  async function prepare(): Promise<{ sessionId: string; revision: number }> {
    const prepared = await harness.command("session.prepare", {
      startPackage: groundStartPackage(),
    });
    if (prepared?.type !== "session.prepared") throw new Error("prepare refused");
    return prepared.payload as { sessionId: string; revision: number };
  }

  it("survives the app losing focus to a prompt the page shows before start", async () => {
    harness = await startForegroundHarness();
    const prepared = await prepare();

    // The page asks for another permission between prepare and start; the
    // system prompt makes the app inactive, then hands focus back.
    await harness.setVisible(false);
    await harness.elapse(20_000);
    await harness.setVisible(true);
    // Nothing is guided yet, so nothing holds the screen.
    expect(harness.phone.keepAwake.held).toBe(false);
    const started = await harness.command("session.start", {}, prepared);

    expect(started?.type).toBe("session.started");
    expect(harness.phone.keepAwake.held).toBe(true);
    expect(stoppedMessages()).toEqual([]);
    expect(harness.sessionEnds).toEqual([]);
  });

  it("lets a reloaded page prepare and start a new trip over the one it abandoned", async () => {
    harness = await startForegroundHarness();
    const abandoned = await prepare();

    // The page reloads and prepares again, without knowing the earlier trip.
    const replacement = await prepare();
    const started = await harness.command("session.start", {}, replacement);

    expect(replacement.sessionId).not.toBe(abandoned.sessionId);
    expect(started?.type).toBe("session.started");
    expect((await harness.session())?.sessionId).toBe(replacement.sessionId);
    // The abandoned page's own start cannot reach the new trip.
    const late = await harness.command("session.start", {}, abandoned);
    expect(late).toMatchObject({ type: "native.error", payload: { code: "revision-conflict" } });
    // Nothing was guided, so the replaced preparation ends without a notice to the page.
    expect(stoppedMessages()).toEqual([]);
  });

  it("still refuses a new trip while one is running", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());

    const refused = await harness.command("session.prepare", {
      startPackage: groundStartPackage(),
    });

    expect(refused).toMatchObject({ type: "native.error", payload: { code: "session-active" } });
  });

  it("ends a preparation that was never started once its grace is over", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await prepare();

    await harness.elapse(PREPARING_GRACE_MS);
    await harness.setVisible(false);

    expect(await harness.session()).toBeNull();
    expect(stoppedMessages()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ sessionId }) }),
    ]);
    expect(harness.sessionEnds).toHaveLength(1);
  });
});
