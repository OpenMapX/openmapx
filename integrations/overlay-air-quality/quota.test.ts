import { describe, expect, it } from "vitest";
import { createOpenAQQuota, OPENAQ_QUOTA_WINDOWS } from "./quota.js";
import { MemoryUpstreamRuntime } from "./test-helpers.js";

describe("OpenAQ distributed quota", () => {
  it("atomically consumes the safety-headroom minute and hour budgets", async () => {
    const runtime = new MemoryUpstreamRuntime();
    const quota = createOpenAQQuota(runtime);
    await expect(quota.consume()).resolves.toMatchObject({ allowed: true });
    expect(runtime.quotaCalls[0]).toEqual({
      bucket: "openaq-v3",
      cost: 1,
      windows: OPENAQ_QUOTA_WINDOWS,
    });
    expect(OPENAQ_QUOTA_WINDOWS).toEqual([
      { id: "minute", limit: 50, durationMs: 60_000 },
      { id: "hour", limit: 1_800, durationMs: 3_600_000 },
    ]);
  });

  it("fails closed when Redis quota state is unavailable", async () => {
    const runtime = new MemoryUpstreamRuntime();
    runtime.quotaDecision = {
      allowed: false,
      remaining: {},
      retryAt: null,
      diagnostic: "store_unavailable",
    };
    await expect(createOpenAQQuota(runtime).consume()).resolves.toMatchObject({
      allowed: false,
      diagnostic: "store_unavailable",
    });
  });

  it("honors Retry-After and rate-reset seconds without sleeping", async () => {
    let now = Date.parse("2026-08-30T12:00:00Z");
    const runtime = new MemoryUpstreamRuntime(() => now);
    const quota = createOpenAQQuota(runtime, { now: () => now });
    await quota.observeResponse(429, { "retry-after": "30", "x-ratelimit-reset": "60" });
    await expect(quota.consume()).resolves.toMatchObject({ allowed: false, retryAt: now + 60_000 });
    expect(runtime.quotaCalls).toHaveLength(0);
    now += 60_001;
    await quota.consume();
    expect(runtime.quotaCalls).toHaveLength(1);
  });
});
