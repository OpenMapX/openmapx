import { describe, expect, it } from "vitest";
import { PrivacyRequestRunner, type RunnerTask } from "./request-runner.js";

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

  it("claims a task once even when two runners wake up", async () => {
    const task: RunnerTask = { id: "t", requestId: "r", status: "pending", attempts: 0 };
    let claimed = false;
    const store = {
      claimDueTask: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...task, status: "running" as const };
      },
      completeTask: async (id: string) => {
        if (id !== "t") throw new Error("wrong task");
      },
      retryTask: async () => {},
      operatorReview: async () => {},
    };
    let handled = 0;
    const handler = async () => {
      handled += 1;
    };
    await Promise.all([
      new PrivacyRequestRunner(store, handler).runOnce(),
      new PrivacyRequestRunner(store, handler).runOnce(),
    ]);
    expect(handled).toBe(1);
  });

  it("retries transient failures and then requires operator review", async () => {
    let state: "retryable" | "operator_review" = "retryable";
    const calls: string[] = [];
    const store = {
      claimDueTask: async () => ({
        id: "t",
        requestId: "r",
        status: "running" as const,
        attempts: state === "retryable" ? 3 : 4,
      }),
      completeTask: async () => {},
      retryTask: async () => {
        state = "retryable";
        calls.push("retry");
      },
      operatorReview: async () => {
        state = "operator_review";
        calls.push("review");
      },
    };
    const runner = new PrivacyRequestRunner(
      store,
      async () => {
        throw new Error("temporary");
      },
      { maxAttempts: 3 },
    );
    await runner.runOnce();
    expect(calls).toEqual(["review"]);
  });
});
