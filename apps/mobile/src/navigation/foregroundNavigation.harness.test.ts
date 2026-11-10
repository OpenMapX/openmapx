import {
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  startForegroundHarness,
} from "./testing/foregroundHarness";

/**
 * The shipped foreground composition, end to end on a fake phone: what the
 * page asks for, what the phone does, and what survives a restart.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

describe("foreground navigation on a fake phone", () => {
  it("starts tracking, guides along the route and tells the shell", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());

    expect(harness.phone.location.running).toBe(true);
    expect(harness.phone.location.profile?.activityType).toBe("automotive-navigation");
    expect(harness.navigatingReports).toEqual([true]);
    expect((await harness.session())?.status).toBe("active");

    await driveStraightRoute(harness, 0, 150);

    const turnCues = harness.phone.speech.cueIds.filter((id) => id.startsWith(`${sessionId}:`));
    expect(turnCues.length).toBeGreaterThan(0);
    expect(harness.sent.some((message) => message.type === "snapshot.update")).toBe(true);
  });

  it("releases the phone when the page ends the trip", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 5);

    const reply = await harness.command("session.stop", {}, { sessionId });

    expect(reply?.type).toBe("session.stopped");
    expect(harness.phone.location.running).toBe(false);
    expect(harness.navigatingReports.at(-1)).toBe(false);
    expect(await harness.session()).toBeNull();
    expect(await harness.deliver([])).toBe(false);
  });

  it("answers a refused command with an error the page can see", async () => {
    harness = await startForegroundHarness();
    await harness.start(groundStartPackage());

    const reply = await harness.command("session.stop", {}, { sessionId: "someone-else" });

    expect(reply).toMatchObject({ type: "native.error", payload: { code: "revision-conflict" } });
    expect(harness.phone.location.running).toBe(true);
  });

  it("continues the same trip after the process is killed and the app reopens", async () => {
    harness = await startForegroundHarness();
    const { sessionId } = await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 140);
    const spokenBefore = [...harness.phone.speech.cueIds];
    const before = await harness.session();

    harness = await harness.relaunch();
    await driveStraightRoute(harness, 140, 150);

    const after = await harness.session();
    expect(after?.sessionId).toBe(sessionId);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? Number.POSITIVE_INFINITY);
    const repeated = harness.phone.speech.cueIds
      .slice(spokenBefore.length)
      .filter((id) => spokenBefore.includes(id));
    expect(repeated).toEqual([]);
  });
});
