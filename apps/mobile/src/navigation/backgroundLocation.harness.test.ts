import { profileFor } from "../location/profiles";
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
 * Android with the phone in a pocket. Restarting the location stream needs
 * the app in the foreground, and JavaScript timers do not fire, so tracking must
 * neither be restarted nor rely on a timer to end.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

async function startOnAndroid() {
  harness = await startForegroundHarness({ phone: createFakePhone({ os: "android" }) });
  return harness;
}

async function rideTowardsTheEnd() {
  await startOnAndroid();
  const itinerary = transitItineraryFixture();
  const { sessionId } = await harness.start(
    transitStartPackageFixture({
      itinerary: {
        ...itinerary,
        endTime: itinerary.legs[1].endTime,
        legs: itinerary.legs.slice(0, 2),
      },
    }),
  );
  await harness.command(
    "transit.action",
    {
      actionId: "board-1",
      itineraryFingerprint: FIXTURE_FINGERPRINT,
      expectedPhase: "walking",
      type: "board",
      legIndex: 1,
    },
    { sessionId },
  );
  expect(harness.phone.location.profile).toEqual(profileFor("transit-cruise", "android"));
  await harness.setVisible(false);
  harness.phone.clock.timersPaused = true;
  // Two stops before the end: the engine asks for the near-event cadence.
  for (const lng of [8.67, 8.66, 8.655]) {
    harness.phone.clock.advance(5_000);
    expect(await harness.deliver([rawFix(harness.phone.clock, [lng, 50.11])])).toBe(true);
  }
}

describe("a transit cadence change with the app in the background", () => {
  it("keeps tracking at the current cadence instead of stopping", async () => {
    await rideTowardsTheEnd();

    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.location.calls).toEqual(["start"]);
    expect(harness.phone.location.profile).toEqual(profileFor("transit-cruise", "android"));
  });

  it("applies the requested cadence when the app is opened", async () => {
    await rideTowardsTheEnd();

    await harness.setVisible(true);

    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.location.profile).toEqual(profileFor("transit-near-event", "android"));
  });
});

describe("a cadence held in a runtime that no longer exists", () => {
  it("is derived again from the session when the app is opened", async () => {
    await rideTowardsTheEnd();
    // The runtime that asked for the near-event cadence is torn down, as the
    // system does a few seconds after a background batch; nothing it held
    // survives.
    harness = await harness.relaunch();
    expect(harness.phone.location.profile).toEqual(profileFor("transit-cruise", "android"));

    await harness.setVisible(true);

    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.location.profile).toEqual(profileFor("transit-near-event", "android"));
  });
});

describe("arriving with the app in the background", () => {
  it("keeps location for the announcement grace and releases it on a later batch", async () => {
    await startOnAndroid();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length - 5);
    await harness.setVisible(false);
    harness.phone.clock.timersPaused = true;

    await driveStraightRoute(harness, STRAIGHT_ROUTE.length - 5, STRAIGHT_ROUTE.length);
    expect((await harness.session())?.status).toBe("arrived");
    expect(harness.phone.speech.cueIds.at(-1)).toMatch(/arriv/);
    expect(harness.phone.location.running).toBe(true);

    const destination = STRAIGHT_ROUTE[STRAIGHT_ROUTE.length - 1];
    await harness.standStill(destination, ARRIVAL_CUE_GRACE_MS - 2_000);
    expect(harness.phone.location.running).toBe(true);
    await harness.standStill(destination, 4_000);

    expect(harness.phone.location.running).toBe(false);
    expect(harness.phone.location.calls).toEqual(["start", "stop"]);
    expect((await harness.session())?.status).toBe("arrived");
  });
});
