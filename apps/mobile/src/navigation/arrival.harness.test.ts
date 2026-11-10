import { TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";
import {
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
  async function arrive() {
    harness = await startForegroundHarness();
    const trip = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);
    return trip;
  }

  it("stops location at the arrival and keeps the outcome for the page", async () => {
    await arrive();

    expect((await harness.session())?.status).toBe("arrived");
    expect(harness.phone.location.running).toBe(false);
    expect(harness.phone.location.calls).toEqual(["start", "stop"]);
    expect(harness.phone.speech.cueIds.at(-1)).toMatch(/arriv/);
    expect(harness.phone.keepAwake.held).toBe(false);
    expect(harness.navigatingReports.at(-1)).toBe(false);
  });

  it("ends cleanly when the page closes the arrival card straight away", async () => {
    const { sessionId } = await arrive();

    const reply = await harness.command("session.complete", {}, { sessionId });

    expect(reply).toMatchObject({ type: "session.stopped", payload: { finalStatus: "arrived" } });
    expect(await harness.session()).toBeNull();
    expect(harness.phone.location.running).toBe(false);
    expect(harness.phone.location.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(harness.phone.keepAwake.held).toBe(false);
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

  async function alightAtTheEnd() {
    harness = await startForegroundHarness();
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
    expect(harness.phone.location.calls).not.toContain("stop");
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
