import type { MobileNavigationSession } from "@openmapx/core/navigation";
import { SerialExecutor } from "../navigation/serialExecutor";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import {
  NavigationRecoveryController,
  type RecoverySessionStore,
} from "./NavigationRecoveryController";

const NOW = 1_700_000_100_000;

function activeSession(overrides: Partial<MobileNavigationSession> = {}): MobileNavigationSession {
  return groundSessionFixture({
    status: "active",
    expiresAtMs: NOW + 60_000,
    ...overrides,
  } as never);
}

function setup(
  options: {
    session?: MobileNavigationSession | null;
    loadKind?: "active" | "none" | "quarantined";
    driverRunning?: boolean;
    permission?: "not-determined" | "foreground" | "background" | "denied" | "limited";
    appActive?: boolean;
  } = {},
) {
  let session = options.session === undefined ? activeSession() : options.session;
  const ended: string[] = [];
  const starts: string[] = [];
  let stopCount = 0;
  let audioStopCount = 0;
  let alertClearCount = 0;
  const store: RecoverySessionStore = {
    inspect: async () => {
      if (options.loadKind === "quarantined") return { kind: "quarantined" };
      if (!session || options.loadKind === "none") return { kind: "none" };
      return { kind: "active", session };
    },
    terminate: async (sessionId) => {
      if (!session || session.sessionId !== sessionId) return false;
      ended.push(sessionId);
      session = null;
      return true;
    },
  };
  const controller = new NavigationRecoveryController({
    store,
    driver: {
      permission: async () => options.permission ?? "background",
      running: async () => options.driverRunning ?? false,
      start: async (profile) => {
        starts.push(profile);
      },
      stop: async () => {
        stopCount += 1;
      },
    },
    stopAudio: async () => {
      audioStopCount += 1;
    },
    clearAlerts: async () => {
      alertClearCount += 1;
    },
    isAppActive: () => options.appActive ?? true,
    now: () => NOW,
    executor: new SerialExecutor(),
  });
  return {
    controller,
    ended,
    starts,
    counts: () => ({ stopCount, audioStopCount, alertClearCount }),
  };
}

describe("NavigationRecoveryController", () => {
  it("derives an already-running session after process recreation from durable state", async () => {
    const context = setup({ driverRunning: true });

    await expect(context.controller.reconcile("active")).resolves.toBe("session-started");
    expect(context.starts).toEqual([]);
    expect(context.counts()).toEqual({ stopCount: 0, audioStopCount: 0, alertClearCount: 0 });
  });

  it("offers an explicit resume when an active persisted session has lost its driver", async () => {
    const context = setup({ driverRunning: false });

    await expect(context.controller.reconcile("active")).resolves.toBe("resume-required");
    expect(context.starts).toEqual([]);
  });

  it("stops device work and reports permission loss when a required grant was revoked", async () => {
    const context = setup({ driverRunning: true, permission: "foreground" });

    await expect(context.controller.reconcile("active")).resolves.toBe("permission-lost");
    expect(context.counts()).toEqual({ stopCount: 1, audioStopCount: 1, alertClearCount: 1 });
    expect(context.ended).toEqual([]);
  });

  it("resumes with the persisted ground mode profile only after an explicit action", async () => {
    const session = activeSession();
    if (session.kind !== "ground") throw new Error("fixture must be ground");
    session.payload.startPackage.mode = "walking";
    const context = setup({ session, driverRunning: false });

    await expect(context.controller.resume()).resolves.toBe("session-started");
    expect(context.starts).toEqual(["walking"]);
  });

  it("refuses resume when the app is not visible", async () => {
    const context = setup({ appActive: false });

    await expect(context.controller.resume()).resolves.toBe("resume-required");
    expect(context.starts).toEqual([]);
  });

  it("ends storage and all device work, and remains safe when repeated", async () => {
    const context = setup({ driverRunning: true });

    await expect(context.controller.end()).resolves.toBe("session-ended");
    await expect(context.controller.end()).resolves.toBe("session-ended");

    expect(context.ended).toEqual(["session-1"]);
    expect(context.counts()).toEqual({ stopCount: 2, audioStopCount: 2, alertClearCount: 2 });
  });

  it("cleans orphaned device work when storage has no active session", async () => {
    const context = setup({ session: null, driverRunning: true });

    await expect(context.controller.reconcile("active")).resolves.toBe("session-ended");
    expect(context.counts()).toEqual({ stopCount: 1, audioStopCount: 1, alertClearCount: 1 });
  });

  it("surfaces a quarantined record only after stopping orphaned device work", async () => {
    const context = setup({ loadKind: "quarantined", driverRunning: true });

    await expect(context.controller.reconcile("active")).resolves.toBe("session-quarantined");
    expect(context.counts()).toEqual({ stopCount: 1, audioStopCount: 1, alertClearCount: 1 });
  });

  it("waits behind work already running on the shared coordinator executor", async () => {
    const executor = new SerialExecutor();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = executor.run(() => held);
    const inspect = jest.fn(async () => ({ kind: "none" as const }));
    const controller = new NavigationRecoveryController({
      store: { inspect, terminate: async () => false },
      driver: {
        permission: async () => "background",
        running: async () => false,
        start: async () => undefined,
        stop: async () => undefined,
      },
      stopAudio: async () => undefined,
      clearAlerts: async () => undefined,
      isAppActive: () => true,
      now: () => NOW,
      executor,
    });

    const recovery = controller.reconcile("active");
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();
    release();
    await first;
    await recovery;
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
