import { TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";
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
 * Arrival ends the need for a position. High-accuracy GPS and the Android
 * foreground service must stop then, not when the user next opens the app.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

describe("arriving by road", () => {
  const DESTINATION = STRAIGHT_ROUTE[STRAIGHT_ROUTE.length - 1];

  async function arrive(os: "ios" | "android" = "ios") {
    harness = await startForegroundHarness({ phone: createFakePhone({ os }) });
    const trip = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);
    expect((await harness.session())?.status).toBe("arrived");
    return trip;
  }

  it("announces the arrival before location stops, and stops it after the grace", async () => {
    await arrive();
    const arrivalCue = harness.phone.speech.cueIds.at(-1) ?? "";
    expect(arrivalCue).toMatch(/arriv/);
    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.keepAwake.held).toBe(false);
    expect(harness.navigatingReports.at(-1)).toBe(false);

    await harness.elapse(ARRIVAL_CUE_GRACE_MS - 1_000);
    expect(harness.phone.location.running).toBe(true);
    await harness.elapse(2_000);

    expect(harness.phone.location.running).toBe(false);
    const { timeline } = harness.phone;
    expect(timeline.indexOf(`speak:${arrivalCue}`)).toBeLessThan(
      timeline.lastIndexOf("location:stop"),
    );
    expect((await harness.session())?.status).toBe("arrived");
  });

  it("releases location by batches alone when the app's timers are paused", async () => {
    await arrive("android");
    // A backgrounded Android app: no JavaScript timer fires, and the user stands
    // still at the destination.
    harness.phone.clock.timersPaused = true;

    await harness.standStill(DESTINATION, ARRIVAL_CUE_GRACE_MS - 1_000);
    expect(harness.phone.location.running).toBe(true);
    await harness.standStill(DESTINATION, 10_000);

    expect(harness.phone.location.running).toBe(false);
  });

  it("ends cleanly when the page closes the arrival card straight away", async () => {
    const { sessionId } = await arrive();

    const reply = await harness.command("session.complete", {}, { sessionId });

    expect(reply).toMatchObject({ type: "session.stopped", payload: { finalStatus: "arrived" } });
    expect(await harness.session()).toBeNull();
    expect(harness.phone.location.running).toBe(false);
    const { calls } = harness.phone.location;
    expect(calls.slice(calls.indexOf("stop"))).not.toContain("start");
    expect(harness.phone.keepAwake.held).toBe(false);

    await harness.elapse(ARRIVAL_CUE_GRACE_MS * 2);
    expect(harness.phone.location.running).toBe(false);
  });
});

describe("arriving by transit", () => {
  /** Walk to the platform, then a ride that ends the trip. */
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

  function riderAction(
    sessionId: string,
    type: "board" | "alight" | "undo",
    expectedPhase: "walking" | "riding" | "arrived",
    actionId: string,
  ) {
    return harness.command(
      "transit.action",
      { actionId, itineraryFingerprint: FIXTURE_FINGERPRINT, expectedPhase, type, legIndex: 1 },
      { sessionId },
    );
  }

  async function alightAtTheEnd(os: "ios" | "android" = "ios") {
    harness = await startForegroundHarness({ phone: createFakePhone({ os }) });
    const trip = await harness.start(rideToTheEnd());
    await riderAction(trip.sessionId, "board", "walking", "board-1");
    harness.phone.clock.advance(60_000);
    const alighted = await riderAction(trip.sessionId, "alight", "riding", "alight-1");
    expect(alighted?.type).toBe("snapshot.update");
    expect((await harness.session())?.status).toBe("arrived");
    return trip;
  }

  it("keeps location through the undo window, then stops it", async () => {
    await alightAtTheEnd();
    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.clock.pendingTimers).toBe(1);

    await harness.elapse(TRANSIT_UNDO_WINDOW_MS - 1_000);
    expect(harness.phone.location.running).toBe(true);

    await harness.elapse(2_000);
    expect(harness.phone.location.running).toBe(false);
    expect((await harness.session())?.status).toBe("arrived");
  });

  it("closes the undo window by batches alone when the app's timers are paused", async () => {
    await alightAtTheEnd("android");
    harness.phone.clock.timersPaused = true;
    expect(harness.phone.location.profile?.distanceIntervalMeters).toBe(0);

    await harness.standStill([8.64, 50.11], TRANSIT_UNDO_WINDOW_MS - 5_000);
    expect(harness.phone.location.running).toBe(true);
    await harness.standStill([8.64, 50.11], 15_000);

    expect(harness.phone.location.running).toBe(false);
    expect((await harness.session())?.status).toBe("arrived");
  });

  it("resumes the trip on an undo inside the window, still tracking", async () => {
    const { sessionId } = await alightAtTheEnd();
    await harness.elapse(60_000);

    const reply = await riderAction(sessionId, "undo", "arrived", "undo-1");

    expect(reply?.type).toBe("snapshot.update");
    const session = await harness.session();
    expect(session?.status).toBe("active");
    expect(session?.kind === "transit" && session.payload.tickState.phase).toBe("riding");
    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.clock.pendingTimers).toBe(0);

    await harness.elapse(TRANSIT_UNDO_WINDOW_MS);
    expect(harness.phone.location.running).toBe(true);
  });

  it("refuses an undo once the window has closed and location has stopped", async () => {
    const { sessionId } = await alightAtTheEnd();
    await harness.elapse(TRANSIT_UNDO_WINDOW_MS + 1_000);

    const reply = await riderAction(sessionId, "undo", "arrived", "undo-late");

    expect(reply).toMatchObject({ type: "native.error" });
    expect((await harness.session())?.status).toBe("arrived");
    expect(harness.phone.location.running).toBe(false);
  });

  it("does not let an ended trip's window stop the next trip", async () => {
    const { sessionId } = await alightAtTheEnd();
    await harness.command("session.complete", {}, { sessionId });
    expect(harness.phone.location.running).toBe(false);

    await harness.start(rideToTheEnd());
    await harness.elapse(TRANSIT_UNDO_WINDOW_MS + 1_000);

    expect(harness.phone.location.running).toBe(true);
    expect((await harness.session())?.status).toBe("active");
  });

  it("stops location on the next batch when the process died during the window", async () => {
    await alightAtTheEnd();
    harness = await harness.relaunch();
    await harness.elapse(TRANSIT_UNDO_WINDOW_MS + 1_000);
    expect(harness.phone.location.running).toBe(true);

    await harness.deliver([rawFix(harness.phone.clock, [8.64, 50.11])]);

    expect(harness.phone.location.running).toBe(false);
    expect((await harness.session())?.status).toBe("arrived");
  });
});
