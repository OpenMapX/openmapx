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
});
