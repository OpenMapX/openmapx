import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPrivacyEmailChallengeWorker,
  type PrivacyEmailChallengeService,
} from "./email-challenge.js";

afterEach(() => vi.useRealTimers());

describe("privacy email challenge worker", () => {
  it("contains background failures, recovers, and becomes unhealthy after stop", async () => {
    vi.useFakeTimers();
    const dispatchPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ sent: 1, retried: 0, failed: 0 });
    const worker = createPrivacyEmailChallengeWorker({
      service: { dispatchPending } as unknown as PrivacyEmailChallengeService,
      sender: async () => {},
      intervalMs: 250,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.health()).toMatchObject({ healthy: false, lastErrorCode: "dispatch-failed" });
    await vi.advanceTimersByTimeAsync(250);
    expect(worker.health()).toMatchObject({ healthy: true, lastErrorCode: null });

    worker.stop();
    expect(worker.health().healthy).toBe(false);
  });
});
