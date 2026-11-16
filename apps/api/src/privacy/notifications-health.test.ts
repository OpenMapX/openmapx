import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "../test/db.js";
import { createPrivacyNotificationWorker } from "./notifications.js";

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
    const database = {
      select: vi.fn(() => {
        throw new Error("connection terminated");
      }),
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

      expect(database.select).toHaveBeenCalledTimes(3);
      expect(unhandled).not.toHaveBeenCalled();
      expect(worker.health()).toEqual({
        healthy: false,
        lastRunAt: null,
        lastErrorCode: "error",
      });
      await expect(worker.runOnce()).rejects.toThrow("connection terminated");
    } finally {
      worker.stop();
      process.off("unhandledRejection", unhandled);
    }
  });
});
