import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { SerialExecutor } from "../serialExecutor";
import { SurfaceController } from "./SurfaceController";

const now = 1_700_000_100_000;
function session(revision = 1) {
  const s = groundSessionFixture({ status: "active", revision });
  s.lastAcceptedFix = { coords: [1, 2], accuracy: 5, timestampMs: now };
  return s;
}
it("runs independently inside navigation's executor and coalesces ordinary revisions", async () => {
  let clock = now;
  const update = jest.fn(async () => {});
  const clear = jest.fn(async () => {});
  const c = new SurfaceController({ update, clear }, () => clock);
  await new SerialExecutor().run(() => c.reconcile(session(), true));
  await c.reconcile(session(2), true);
  expect(update).toHaveBeenCalledTimes(1);
  clock += 5000;
  await c.reconcile(session(3), true);
  expect(update).toHaveBeenCalledTimes(2);
  await c.reconcile(session(1), true);
  expect(update).toHaveBeenCalledTimes(2);
  await c.reconcile(null, true);
  expect(clear).toHaveBeenCalledWith("session-1");
});
it("clears foreground-only background work and retries failed adapter operations", async () => {
  const update = jest.fn().mockRejectedValueOnce(new Error("OS")).mockResolvedValue(undefined);
  const clear = jest.fn(async () => {});
  const c = new SurfaceController({ update, clear }, () => now);
  await c.reconcile(session(), true);
  await c.reconcile(session(), true);
  expect(update).toHaveBeenCalledTimes(2);
  await c.reconcile({ ...session(2), permissionMode: "foreground-only" }, false);
  expect(clear).toHaveBeenCalledWith("session-1");
});
it("serializes old updates before terminal cleanup and the replacement owner", async () => {
  let release!: () => void;
  const log: string[] = [];
  const c = new SurfaceController(
    {
      update: async (m) => {
        log.push(m.sessionId);
        if (m.sessionId === "session-1")
          await new Promise<void>((r) => {
            release = r;
          });
      },
      clear: async (id) => {
        log.push(`clear:${id}`);
      },
    },
    () => now,
  );
  const first = c.reconcile(session(), true);
  await Promise.resolve();
  const end = c.reconcile(null, true);
  const next = c.reconcile({ ...session(), sessionId: "session-2" }, true);
  release();
  await Promise.all([first, end, next]);
  expect(log).toEqual(["session-1", "clear:session-1", "session-2"]);
});
it("retries a deferred new-session start even if the previous trip had a higher revision", async () => {
  const update = jest
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const c = new SurfaceController({ update, clear: async () => {} }, () => now);
  await c.reconcile(session(100), true);
  await c.reconcile({ ...session(1), sessionId: "B" }, false);
  await c.reconcile({ ...session(1), sessionId: "B" }, true);
  expect(update).toHaveBeenCalledTimes(3);
});
