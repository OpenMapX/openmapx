import { describe, expect, it, vi } from "vitest";
import { maptilerDailyBudget, sharedAdmissionOf } from "../provider-daily-budget";
import type { UpstreamRuntime } from "../upstream-runtime";

describe("maptilerDailyBudget", () => {
  it("is off unless the operator sets a limit", () => {
    expect(maptilerDailyBudget(null, {})).toBeNull();
    expect(maptilerDailyBudget(null, { MAPTILER_DAILY_REQUEST_LIMIT: "0" })).toBeNull();
    expect(maptilerDailyBudget(null, { MAPTILER_DAILY_REQUEST_LIMIT: "5" })).not.toBeNull();
  });

  it("counts every caller against the one shared MapTiler counter", async () => {
    const admitSharedRequest = vi.fn(async () => ({ allowed: true as const, remaining: 4 }));
    const runtime = { admitSharedRequest } as unknown as UpstreamRuntime;
    const budget = maptilerDailyBudget(sharedAdmissionOf(runtime), {
      MAPTILER_DAILY_REQUEST_LIMIT: "5",
    });

    expect(await budget?.admit()).toEqual({ allowed: true });
    expect(admitSharedRequest).toHaveBeenCalledWith({
      scope: "provider-daily-budget",
      key: "maptiler",
      policy: { id: "daily", limit: 5, durationMs: 86_400_000, minIntervalMs: 0 },
    });
  });

  it("has no shared admission without a store", () => {
    expect(sharedAdmissionOf(undefined)).toBeNull();
    expect(sharedAdmissionOf({} as UpstreamRuntime)).toBeNull();
  });
});
