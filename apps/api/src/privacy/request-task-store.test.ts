import { describe, expect, it } from "vitest";
import { createPrivacyRequestTaskStore } from "./request-task-store.js";

describe("privacy task store", () => {
  it("exposes a durable CAS task store with recovery", () => {
    const store = createPrivacyRequestTaskStore({} as never);
    expect(store.claimDueTask).toBeTypeOf("function");
    expect(store.completeTask).toBeTypeOf("function");
    expect(store.retryTask).toBeTypeOf("function");
    expect(store.operatorReview).toBeTypeOf("function");
    expect(store.recoverInterrupted).toBeTypeOf("function");
  });
});
