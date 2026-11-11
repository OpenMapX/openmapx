import type { GroundMobileSession } from "@openmapx/core/navigation";
import {
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
  WHOLE_ROUTE_TIMEOUT_MS,
} from "./testing/foregroundHarness";

/**
 * A tunnel on the phone: real fixes stop, and while the app is visible the
 * puck keeps moving along the route from the last real fix, then stops
 * honestly when the estimate runs out or the trip is over.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

async function ground(): Promise<GroundMobileSession> {
  const session = await harness.session();
  if (session?.kind !== "ground") throw new Error("no ground session");
  return session;
}

function along(session: GroundMobileSession): number {
  return (session.payload.progress as { alongMeters: number }).alongMeters;
}

/** Lets `seconds` pass one second at a time with no fix delivered. */
async function noFixesFor(seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second += 1) await harness.elapse(1_000);
}

function coastedSnapshots(): number {
  return harness.sent.filter(
    (message) =>
      message.type === "snapshot.update" &&
      (message.payload as { snapshot?: { coasting?: boolean } }).snapshot?.coasting === true,
  ).length;
}

describe("coasting through a gap in location delivery", () => {
  it("moves along the route from the last real fix while no fix arrives", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);
    const before = await ground();

    await noFixesFor(8);

    const during = await ground();
    expect(during.payload.coasting).toBe(true);
    expect(along(during)).toBeGreaterThan(along(before) + 50);
    // The estimate is never recorded as a measured position.
    expect(during.lastAcceptedFix).toEqual(before.lastAcceptedFix);
    expect(coastedSnapshots()).toBeGreaterThan(0);

    harness.phone.clock.advance(1_000);
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[20])]);

    const after = await ground();
    expect(after.payload.coasting).toBe(false);
    expect(after.lastAcceptedFix?.timestampMs).toBe(harness.phone.clock.now());
  });

  it("ends the coast on the next real fix and starts any later coast from that fix", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);
    await noFixesFor(6);
    expect((await ground()).payload.coasting).toBe(true);

    harness.phone.clock.advance(1_000);
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[18])]);
    const resumed = await ground();
    expect(resumed.payload.coasting).toBe(false);
    expect(resumed.payload.coastingAnchor?.acceptedAtMs).toBe(harness.phone.clock.now());

    // Inside the start delay after the real fix nothing is estimated.
    await noFixesFor(2);
    const settled = await ground();
    expect(settled.revision).toBe(resumed.revision);
    expect(along(settled)).toBe(along(resumed));

    // A later gap coasts on from the new fix, not from the old estimate.
    await noFixesFor(3);
    const coasting = await ground();
    expect(coasting.payload.coasting).toBe(true);
    expect(along(coasting)).toBeGreaterThan(along(resumed));
    expect(coasting.payload.coastingAnchor).toEqual(resumed.payload.coastingAnchor);
  });

  it("waits a few seconds after the last fix before estimating anything", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);
    const before = await ground();

    await noFixesFor(2);

    const after = await ground();
    expect(after.revision).toBe(before.revision);
    expect(after.payload.coasting).toBe(false);
  });

  it("does not coast while the app is out of sight", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);
    await harness.setVisible(false);
    const before = await ground();

    await noFixesFor(8);

    const after = await ground();
    expect(after.payload.coasting).toBe(false);
    expect(along(after)).toBe(along(before));
  });

  it("stops for good when the user ends the trip mid-coast", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);
    await noFixesFor(5);
    expect((await ground()).payload.coasting).toBe(true);

    await harness.command("session.stop", {}, { sessionId });
    const sentAtEnd = harness.sent.length;
    await noFixesFor(10);

    expect(await harness.session()).toBeNull();
    expect(harness.sent.slice(sentAtEnd)).toEqual([]);
    expect(harness.phone.clock.pendingTimers).toBe(0);
  });

  it(
    "stops once the trip has arrived",
    async () => {
      harness = await startForegroundHarness();
      await harness.start(groundStartPackage());
      await driveStraightRoute(harness, 0, STRAIGHT_ROUTE.length);
      const arrived = await ground();
      expect(arrived.status).toBe("arrived");

      await noFixesFor(8);

      expect((await ground()).revision).toBe(arrived.revision);
    },
    WHOLE_ROUTE_TIMEOUT_MS,
  );

  it("stops when the estimate runs out instead of drifting on", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 12);

    await noFixesFor(125);
    const exhausted = await ground();
    await noFixesFor(10);

    expect((await ground()).revision).toBe(exhausted.revision);
  });
});
