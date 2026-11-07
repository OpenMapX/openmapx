import { describe, expect, it, vi } from "vitest";
import { PrivacyRequestRunner } from "./request-runner.js";

describe("PrivacyRequestRunner", () => {
  it("does not claim work while the exact release gate is closed", async () => {
    let claims = 0;
    let handled = 0;
    const runner = new PrivacyRequestRunner(
      {
        claimDueTask: async () => {
          claims += 1;
          return null;
        },
        completeTask: async () => {},
        retryTask: async () => {},
        operatorReview: async () => {},
      },
      async () => {
        handled += 1;
      },
      { releaseReady: async () => false },
    );
    expect(await runner.runOnce()).toBe(false);
    expect(claims).toBe(0);
    expect(handled).toBe(0);
  });

  it("does not handle or settle work when the store has no due task", async () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const store = {
      claimDueTask: vi.fn(async () => null),
      completeTask: vi.fn(async () => {}),
      retryTask: vi.fn(async () => {}),
      operatorReview: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const runner = new PrivacyRequestRunner(store, handler, { now: () => now });

    expect(await runner.runOnce()).toBe(false);
    expect(store.claimDueTask).toHaveBeenCalledExactlyOnceWith(now);
    expect(handler).not.toHaveBeenCalled();
    expect(store.completeTask).not.toHaveBeenCalled();
    expect(store.retryTask).not.toHaveBeenCalled();
    expect(store.operatorReview).not.toHaveBeenCalled();
  });

  it("retries transient failures and then requires operator review", async () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const task = { id: "t", requestId: "r", status: "running" as const };
    const store = {
      claimDueTask: vi
        .fn()
        .mockResolvedValueOnce({ ...task, attempts: 2 })
        .mockResolvedValueOnce({ ...task, attempts: 3 }),
      completeTask: vi.fn(async () => {}),
      retryTask: vi.fn(async () => {}),
      operatorReview: vi.fn(async () => {}),
    };
    const runner = new PrivacyRequestRunner(
      store,
      async () => {
        throw new Error("temporary");
      },
      { maxAttempts: 3, retryDelayMs: 1000, now: () => now },
    );

    await runner.runOnce();
    expect(store.retryTask).toHaveBeenCalledExactlyOnceWith(
      "t",
      new Date("2026-09-05T12:00:02Z"),
      "collector-transient",
    );
    expect(store.operatorReview).not.toHaveBeenCalled();

    await runner.runOnce();
    expect(store.operatorReview).toHaveBeenCalledExactlyOnceWith("t", "collector-exhausted");
    expect(store.retryTask).toHaveBeenCalledTimes(1);
    expect(store.completeTask).not.toHaveBeenCalled();
  });
});
