import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerHealth } from "../health.js";

describe("ProviderHealth", () => {
  beforeEach(() => {
    // Reset by recording success for any provider we might use
    // The singleton keeps state between tests
    providerHealth.recordSuccess("test-provider");
    providerHealth.recordSuccess("another-provider");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports unknown providers as healthy", () => {
    expect(providerHealth.isHealthy("brand-new-provider")).toBe(true);
  });

  it("stays healthy after a few failures (below threshold)", () => {
    providerHealth.recordFailure("test-provider");
    providerHealth.recordFailure("test-provider");
    providerHealth.recordFailure("test-provider");
    providerHealth.recordFailure("test-provider");
    // 4 failures, threshold is 5
    expect(providerHealth.isHealthy("test-provider")).toBe(true);
  });

  it("becomes unhealthy after 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("test-provider");
    }
    expect(providerHealth.isHealthy("test-provider")).toBe(false);
  });

  it("recovers after cooldown period expires", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("test-provider");
    }
    expect(providerHealth.isHealthy("test-provider")).toBe(false);

    // Advance past 5-minute cooldown
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(providerHealth.isHealthy("test-provider")).toBe(true);
  });

  it("resets failure count after cooldown expiry", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("test-provider");
    }
    // Advance past cooldown
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(providerHealth.isHealthy("test-provider")).toBe(true);

    // Should need another 5 failures to disable again
    providerHealth.recordFailure("test-provider");
    providerHealth.recordFailure("test-provider");
    expect(providerHealth.isHealthy("test-provider")).toBe(true);
  });

  it("clears state after recordSuccess", () => {
    for (let i = 0; i < 3; i++) {
      providerHealth.recordFailure("test-provider");
    }
    providerHealth.recordSuccess("test-provider");
    // After success, should start fresh — needs 5 new failures
    for (let i = 0; i < 4; i++) {
      providerHealth.recordFailure("test-provider");
    }
    expect(providerHealth.isHealthy("test-provider")).toBe(true);
  });

  it("getStatus returns tracked providers", () => {
    providerHealth.recordFailure("test-provider");
    providerHealth.recordFailure("test-provider");
    const status = providerHealth.getStatus();
    expect(status["test-provider"]).toBeDefined();
    expect(status["test-provider"].healthy).toBe(true);
    expect(status["test-provider"].failures).toBe(2);
  });

  it("getStatus shows disabled provider with disabledUntil", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("test-provider");
    }
    const status = providerHealth.getStatus();
    expect(status["test-provider"].healthy).toBe(false);
    expect(status["test-provider"].disabledUntil).toBeDefined();
  });

  it("getStatus does not include disabledUntil for healthy providers", () => {
    providerHealth.recordFailure("test-provider");
    const status = providerHealth.getStatus();
    expect(status["test-provider"].disabledUntil).toBeUndefined();
  });
});
