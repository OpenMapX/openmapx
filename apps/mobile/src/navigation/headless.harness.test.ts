import type { GroundMobileSession } from "@openmapx/core/navigation";
import {
  createFakePhone,
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  type HeadlessHarness,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
} from "./testing/foregroundHarness";

/**
 * The operating system can kill the app mid-trip and start the process again
 * for a location batch, with no app and no page. That process composes
 * navigation from the same ports as the visible app, so an off-route driver
 * still gets a new route there.
 */

let foreground: ForegroundHarness | null = null;
let headless: HeadlessHarness | null = null;
afterEach(async () => {
  if (headless) await headless.shutdown();
  else await foreground?.shutdown();
  foreground = null;
  headless = null;
});

const DIRECTIONS_PATH = "/api/integrations/routing/directions";
/** Well away from the followed road. */
const OFF_ROUTE: readonly [number, number] = [8.75, 50.2];
const DESTINATION = STRAIGHT_ROUTE[STRAIGHT_ROUTE.length - 1];

/** A route from where the driver actually is to the destination. */
function detour() {
  const geometry = Array.from({ length: 40 }, (_, index) => [
    OFF_ROUTE[0] + ((DESTINATION[0] - OFF_ROUTE[0]) * index) / 39,
    OFF_ROUTE[1] + ((DESTINATION[1] - OFF_ROUTE[1]) * index) / 39,
  ]);
  return {
    distance: 22_000,
    duration: 1_300,
    geometry,
    mode: "driving",
    steps: [
      {
        instruction: "Head south-east",
        verbalSuccinct: "Head south-east",
        verbalAlert: "Head south-east now",
        distance: 22_000,
        duration: 1_300,
        name: "Umleitung",
      },
    ],
  };
}

async function groundSession(harness: { session(): Promise<unknown> }) {
  const session = (await harness.session()) as GroundMobileSession | null;
  if (session?.kind !== "ground") throw new Error("no ground session");
  return session;
}

describe("a process the system started for a location batch", () => {
  it.each(["ios", "android"] as const)("reroutes an off-route driver (%s)", async (os) => {
    foreground = await startForegroundHarness({ phone: createFakePhone({ os }) });
    await foreground.start(groundStartPackage());
    await driveStraightRoute(foreground, 0, 10);

    headless = await foreground.relaunchHeadless();
    const { phone } = headless;
    phone.clock.timersPaused = os === "android";
    phone.network.respond = async (url) =>
      url.includes(DIRECTIONS_PATH)
        ? Response.json({ routes: [detour()] })
        : Promise.reject(new TypeError("Network request failed"));

    for (let fix = 0; fix < 20; fix += 1) {
      phone.clock.advance(1_000);
      expect(await headless.deliver([rawFix(phone.clock, OFF_ROUTE)])).toBe(true);
    }

    const session = await groundSession(headless);
    expect(phone.network.requests.some((url) => url.includes(DIRECTIONS_PATH))).toBe(true);
    expect(session.payload.startPackage.route.geometry[0]).toEqual([...OFF_ROUTE]);
    expect(session.payload.reroute.status).not.toBe("pending");
    expect(phone.location.running).toBe(true);
    // Never prompts, never holds the screen and never restarts the stream.
    expect(phone.permissionScreens.shown).toEqual([]);
    expect(phone.keepAwake.held).toBe(false);
    expect(phone.location.calls).toEqual(["start"]);
  });

  it("hands batches to the visible app's composition once the app is opened", async () => {
    foreground = await startForegroundHarness();
    await foreground.start(groundStartPackage());
    headless = await foreground.relaunchHeadless();
    await headless.deliver([rawFix(headless.phone.clock, STRAIGHT_ROUTE[1])]);

    const reopened = await startForegroundHarness({ phone: headless.phone });
    headless.phone.clock.advance(1_000);
    // The background task's own choice: the visible app's composition, now that it exists.
    await headless.deliver([rawFix(headless.phone.clock, STRAIGHT_ROUTE[2])]);

    expect(reopened.sent.some((message) => message.type === "snapshot.update")).toBe(true);
    reopened.navigation.dispose();
  });
});
