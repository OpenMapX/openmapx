import type { NativeToWebMessage, WebToNativeMessage } from "@openmapx/core/navigation";
import { getDatabase } from "../storage/database";
import { migrateSessionSchema } from "../storage/migrations";
import { openTestDatabase } from "../storage/testing/nodeSqliteDatabase";
import { createCoordinator, resetCoordinatorCache } from "./createCoordinator";
import type { EffectPorts } from "./effects";

jest.mock("../storage/database", () => ({ getDatabase: jest.fn() }));

const NOW = 1_700_000_000_000;
const mockedGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;

function command(messageId: string): WebToNativeMessage {
  return {
    protocolVersion: 3,
    type: "snapshot.request",
    messageId,
    channelNonce: "nonce",
    sentAtMs: NOW,
    payload: {},
  };
}

function overrides(sent: Array<{ type: NativeToWebMessage["type"]; forMessageId?: string }>) {
  const ports: EffectPorts = {
    driver: {
      start: async () => undefined,
      stop: async () => undefined,
      updateProfile: async () => undefined,
      isRunning: async () => false,
    },
    audio: { speak: async () => undefined, stop: async () => undefined },
    alerts: { reconcile: async () => undefined, cancelSession: async () => undefined },
    publish: { snapshot: async () => undefined, event: async () => undefined },
    remote: {
      reroute: async () => undefined,
      transitRefresh: async () => undefined,
      transitReplan: async () => undefined,
    },
    diagnostics: { record: () => undefined },
  };

  return {
    bridge: {
      send: (
        type: NativeToWebMessage["type"],
        _payload: unknown,
        options?: { forMessageId?: string },
      ) => sent.push({ type, forMessageId: options?.forMessageId }),
    },
    permissions: {
      state: async () => "background" as const,
      isAppActive: () => true,
      requestForStart: async () => "background" as const,
    },
    driver: { isRunning: async () => false },
    ports,
    clock: () => NOW,
    newSessionId: () => "session-1",
  };
}

describe("createCoordinator environment ownership", () => {
  beforeEach(() => resetCoordinatorCache());

  it.each(["foreground-first", "headless-first"] as const)(
    "binds replies to the submitting environment when initialized %s",
    async (order) => {
      const database = openTestDatabase();
      await migrateSessionSchema(database, NOW);
      mockedGetDatabase.mockResolvedValue(database);
      const foregroundSent: Array<{
        type: NativeToWebMessage["type"];
        forMessageId?: string;
      }> = [];
      const headlessSent: Array<{ type: NativeToWebMessage["type"]; forMessageId?: string }> = [];

      const foregroundOverrides = overrides(foregroundSent);
      const headlessOverrides = overrides(headlessSent);
      const first =
        order === "foreground-first"
          ? await createCoordinator(foregroundOverrides)
          : await createCoordinator(headlessOverrides);
      const second =
        order === "foreground-first"
          ? await createCoordinator(headlessOverrides)
          : await createCoordinator(foregroundOverrides);
      const foreground = order === "foreground-first" ? first : second;
      const headless = order === "foreground-first" ? second : first;

      await foreground.coordinator.dispatch(command("foreground-command"));
      await headless.coordinator.dispatch(command("headless-command"));

      expect(foreground.coordinator).not.toBe(headless.coordinator);
      expect(foregroundSent).toEqual([
        { type: "snapshot.update", forMessageId: "foreground-command" },
      ]);
      expect(headlessSent).toEqual([{ type: "snapshot.update", forMessageId: "headless-command" }]);
      await database.closeAsync();
    },
  );

  it("keeps foreground adapters after a foreground-headless-foreground transition", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, NOW);
    mockedGetDatabase.mockResolvedValue(database);
    const firstForegroundSent: Array<{
      type: NativeToWebMessage["type"];
      forMessageId?: string;
    }> = [];
    const headlessSent: Array<{ type: NativeToWebMessage["type"]; forMessageId?: string }> = [];
    const resumedForegroundSent: Array<{
      type: NativeToWebMessage["type"];
      forMessageId?: string;
    }> = [];

    const foreground = await createCoordinator(overrides(firstForegroundSent));
    const headless = await createCoordinator(overrides(headlessSent));
    const resumedForeground = await createCoordinator(overrides(resumedForegroundSent));

    await foreground.coordinator.dispatch(command("initial-foreground-command"));
    await headless.coordinator.dispatch(command("headless-command"));
    await resumedForeground.coordinator.dispatch(command("resumed-foreground-command"));

    expect(firstForegroundSent).toEqual([
      { type: "snapshot.update", forMessageId: "initial-foreground-command" },
    ]);
    expect(headlessSent).toEqual([{ type: "snapshot.update", forMessageId: "headless-command" }]);
    expect(resumedForegroundSent).toEqual([
      { type: "snapshot.update", forMessageId: "resumed-foreground-command" },
    ]);
    await database.closeAsync();
  });

  it("serializes operations across environment-specific coordinators", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, NOW);
    mockedGetDatabase.mockResolvedValue(database);
    const first = await createCoordinator(overrides([]));
    const second = await createCoordinator(overrides([]));
    const originalLoad = first.repository.loadActive.bind(first.repository);
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    jest.spyOn(first.repository, "loadActive").mockImplementation(async (nowMs) => {
      calls += 1;
      if (calls === 1) await held;
      return originalLoad(nowMs);
    });

    const firstDispatch = first.coordinator.dispatch(command("first-command"));
    await Promise.resolve();
    const secondDispatch = second.coordinator.dispatch(command("second-command"));
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([firstDispatch, secondDispatch]);
    expect(calls).toBe(2);
    await database.closeAsync();
  });
});
