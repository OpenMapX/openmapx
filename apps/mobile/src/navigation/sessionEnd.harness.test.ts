import {
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  TRANSIT_UNDO_WINDOW_MS,
} from "@openmapx/core/navigation";
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

  it("ends the arrival with one notice when the app is opened after the window", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await alightAtTheEnd();
    await harness.setVisible(false);
    await harness.elapse(TRANSIT_UNDO_WINDOW_MS + 1_000);

    await harness.setVisible(true);

    expect(await harness.session()).toBeNull();
    expect(stoppedMessages()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ sessionId, finalStatus: "arrived" }),
      }),
    ]);
    expect(harness.sessionEnds).toHaveLength(1);
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
