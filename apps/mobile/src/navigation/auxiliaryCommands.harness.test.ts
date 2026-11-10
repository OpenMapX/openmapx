import type { WebToNativeMessage } from "@openmapx/core/navigation";
import type { CommandResponse } from "./NavigationCoordinator";
import {
  type ForegroundHarness,
  groundStartPackage,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
} from "./testing/foregroundHarness";

/**
 * A one-shot request can wait on the user: a location prompt, a settings page
 * or a sign-in in the system browser. None of it is about the trip, so none of
 * it may hold up the location batches that keep guidance moving.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

/** An auxiliary handler whose answer waits until the test releases it. */
function heldAuxiliary() {
  const asked: WebToNativeMessage["type"][] = [];
  let release: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (command: WebToNativeMessage): Promise<CommandResponse | null> => {
    asked.push(command.type);
    await answered;
    return {
      type: "location.result",
      payload: { requestId: "fix-1", status: "denied" },
    };
  };
  return { handler, asked, release: () => release() };
}

describe("one-shot requests during a trip", () => {
  it("does not hold a location batch behind a pending permission prompt", async () => {
    const prompt = heldAuxiliary();
    harness = await startForegroundHarness({ auxiliary: prompt.handler });
    await harness.start(groundStartPackage());
    const before = (await harness.session())?.revision ?? 0;

    const reply = harness.command("location.request", {
      requestId: "fix-1",
      accuracy: "precise",
      timeoutMs: 30_000,
      maxAgeMs: 10_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompt.asked).toEqual(["location.request"]);

    harness.phone.clock.advance(1_000);
    expect(await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[1])])).toBe(true);

    const session = await harness.session();
    expect(session?.revision).toBeGreaterThan(before);
    expect(session?.lastAcceptedFix).not.toBeNull();

    prompt.release();
    expect(await reply).toMatchObject({
      type: "location.result",
      payload: { requestId: "fix-1", status: "denied" },
    });
  });

  it("refuses a one-shot request the shell cannot answer", async () => {
    harness = await startForegroundHarness();

    const reply = await harness.command("settings.open", { target: "application" });

    expect(reply).toMatchObject({
      type: "native.error",
      payload: { code: "unsupported-capability" },
    });
  });
});
