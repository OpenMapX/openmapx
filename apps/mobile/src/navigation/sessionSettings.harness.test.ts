import {
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
} from "./testing/foregroundHarness";

/**
 * Settings the user changes during a trip — voice, keep-screen-on, voice
 * timing — must change what the native session does, not just what the page
 * shows.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

async function currentRevision(): Promise<number> {
  const session = await harness.session();
  if (!session) throw new Error("no session");
  return session.revision;
}

/** The fix index at which each stage of the first turn was announced. */
async function announcementIndexes(from: number, to: number): Promise<Record<string, number>> {
  const at: Record<string, number> = {};
  for (let index = from; index < to; index += 1) {
    harness.phone.clock.advance(1_000);
    const before = harness.phone.speech.cueIds.length;
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[index])]);
    for (const cueId of harness.phone.speech.cueIds.slice(before)) {
      const stage = cueId.match(/:1:(far|near|now)$/)?.[1];
      if (stage) at[stage] = index;
    }
  }
  return at;
}

describe("voice guidance switched off and on during a trip", () => {
  it("silences the cues that follow and cuts off the one being spoken", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 120);
    const stopsBefore = harness.phone.speech.stops;

    const reply = await harness.command(
      "settings.update",
      { voiceEnabled: false },
      { sessionId, revision: await currentRevision() },
    );

    expect(reply?.type).toBe("snapshot.update");
    expect(harness.phone.speech.stops).toBeGreaterThan(stopsBefore);
    const spokenWhileMuted = harness.phone.speech.cueIds.length;
    await driveStraightRoute(harness, 120, 150);
    expect(harness.phone.speech.cueIds.length).toBe(spokenWhileMuted);

    await harness.command("settings.update", { voiceEnabled: true }, { sessionId });
    await driveStraightRoute(harness, 150, STRAIGHT_ROUTE.length);
    expect(harness.phone.speech.cueIds.at(-1)).toMatch(/arriv/);
  });

  it("applies a change sent against a revision the page saw before newer progress", async () => {
    harness = await startForegroundHarness();
    const { sessionId, revision: acknowledged } = await harness.start(groundStartPackage());
    // Progress commits about once a second, so the page's last snapshot is
    // routinely a revision or two behind by the time the user taps.
    await driveStraightRoute(harness, 0, 3);

    const reply = await harness.command(
      "settings.update",
      { voiceEnabled: false },
      { sessionId, revision: acknowledged },
    );

    expect(reply?.type).toBe("snapshot.update");
    const session = await harness.session();
    expect(session?.kind === "ground" && session.payload.startPackage.settings.voiceEnabled).toBe(
      false,
    );
  });

  it("refuses a change addressed to another trip", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());

    const reply = await harness.command(
      "settings.update",
      { voiceEnabled: false },
      { sessionId: "an-earlier-trip" },
    );

    expect(reply).toMatchObject({ type: "native.error", payload: { code: "revision-conflict" } });
  });
});

describe("voice timing changed during a trip", () => {
  it.each([
    // The shared policy's multipliers, 1.5 and 0.6, around normal's 132.
    ["early", 128],
    ["late", 136],
  ] as const)("moves the next announcement when set to %s", async (timing, farIndex) => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage({ voiceTiming: "normal" }));
    await driveStraightRoute(harness, 0, 100);

    await harness.command("settings.update", { voiceTiming: timing }, { sessionId });

    expect((await announcementIndexes(100, 145)).far).toBe(farIndex);
  });

  it("announces at the normal distance when the setting is unchanged", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage({ voiceTiming: "normal" }));
    await driveStraightRoute(harness, 0, 100);

    expect((await announcementIndexes(100, 145)).far).toBe(132);
  });

  it("uses the timing the trip was started with", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage({ voiceTiming: "late" }));

    expect((await announcementIndexes(0, 145)).far).toBe(136);
  });
});

describe("keep-screen-on", () => {
  it("holds the screen only while the trip runs, the app is visible and the setting is on", async () => {
    harness = await startForegroundHarness();
    const { keepAwake } = harness.phone;
    const { sessionId } = await harness.start(groundStartPackage({ keepScreenOn: true }));
    expect(keepAwake.held).toBe(true);

    await harness.command("settings.update", { keepScreenOn: false }, { sessionId });
    expect(keepAwake.held).toBe(false);
    await driveStraightRoute(harness, 0, 3);
    expect(keepAwake.held).toBe(false);

    await harness.command("settings.update", { keepScreenOn: true }, { sessionId });
    expect(keepAwake.held).toBe(true);

    await harness.setVisible(false);
    expect(keepAwake.held).toBe(false);
    await harness.setVisible(true);
    expect(keepAwake.held).toBe(true);

    await harness.command("session.stop", {}, { sessionId });
    expect(keepAwake.held).toBe(false);
  });

  it("never holds the screen for a trip started with the setting off", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage({ keepScreenOn: false }));
    await driveStraightRoute(harness, 0, 3);
    await harness.setVisible(false);
    await harness.setVisible(true);

    expect(harness.phone.keepAwake.calls).not.toContain("activate");
  });

  it("releases the screen when the composition is disposed mid-trip", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage({ keepScreenOn: true }));
    expect(harness.phone.keepAwake.held).toBe(true);

    harness.navigation.dispose();
    await harness.settle();

    expect(harness.phone.keepAwake.held).toBe(false);
  });
});
