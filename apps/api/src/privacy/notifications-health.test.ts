import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "../test/db.js";
import { createPrivacyNotificationWorker, dispatchPrivacyNotifications } from "./notifications.js";

afterEach(() => vi.useRealTimers());

describe("privacy notification worker health", () => {
  it("requires a started worker with a fresh successful dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const database = createDbMock();
    const worker = createPrivacyNotificationWorker({
      database: database.db as never,
      intervalMs: 1_000,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.health().healthy).toBe(true);
    worker.stop();
    expect(worker.health().healthy).toBe(false);
  });

  it("records a failed scheduled dispatch without an unhandled rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const connectionTerminated = () => {
      throw new Error("connection terminated");
    };
    const database = {
      select: vi.fn(connectionTerminated),
      update: vi.fn(connectionTerminated),
    };
    const worker = createPrivacyNotificationWorker({
      database: database as never,
      intervalMs: 1_000,
    });
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(2_500);
      worker.stop();
      vi.useRealTimers();
      // One real macrotask turn so Node's unhandled-rejection check runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(database.update).toHaveBeenCalledTimes(3);
      expect(unhandled).not.toHaveBeenCalled();
      expect(worker.health()).toEqual({
        healthy: false,
        lastRunAt: null,
        lastErrorCode: "ERROR",
      });
      await expect(worker.runOnce()).rejects.toThrow("connection terminated");
    } finally {
      worker.stop();
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("privacy notification dispatcher bounds", () => {
  it("rejects a stale-claim threshold below one minute or above one day", async () => {
    const database = createDbMock();
    for (const staleSendingMs of [59_999, 86_400_001, 1.5])
      await expect(
        dispatchPrivacyNotifications({ database: database.db as never, staleSendingMs }),
      ).rejects.toThrow("invalid notification dispatcher bounds");
    expect(database.db.update).not.toHaveBeenCalled();
  });
});
