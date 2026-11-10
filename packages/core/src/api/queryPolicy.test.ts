import { afterEach, describe, expect, it } from "vitest";
import { ApiClientError } from "./client";
import {
  configureOfflineQueryRetention,
  DETAIL_QUERY_POLICY,
  MAP_QUERY_POLICY,
  OFFLINE_RETENTION_GC_TIME_MS,
  RAPID_QUERY_POLICY,
  rateLimitAwareRetry,
} from "./queryPolicy";

afterEach(() => configureOfflineQueryRetention(false));

describe("query policies", () => {
  it("switch every policy to offline retention when the host enables it", () => {
    configureOfflineQueryRetention(true);
    for (const policy of [RAPID_QUERY_POLICY, MAP_QUERY_POLICY, DETAIL_QUERY_POLICY]) {
      expect(policy.gcTime).toBe(OFFLINE_RETENTION_GC_TIME_MS);
    }
    configureOfflineQueryRetention(false);
    expect(DETAIL_QUERY_POLICY.gcTime).toBe(15 * 60_000);
  });
});

describe("rate-limit-aware retry", () => {
  const limited = (retryAfterSeconds: number | null) =>
    new ApiClientError(429, null, retryAfterSeconds);
  const failure = new ApiClientError(502, null, null);

  it("retries a 429 up to five times whatever the client default", () => {
    const policy = rateLimitAwareRetry(false);
    expect([0, 4, 5].map((count) => policy.retry(count, limited(2)))).toEqual([true, true, false]);
  });

  it("leaves every other failure to the client's own retry default", () => {
    expect(rateLimitAwareRetry(false).retry(0, failure)).toBe(false);
    expect(rateLimitAwareRetry(1).retry(0, failure)).toBe(true);
    expect(rateLimitAwareRetry(1).retry(1, failure)).toBe(false);
    expect(rateLimitAwareRetry((count) => count < 2).retry(1, failure)).toBe(true);
    expect(rateLimitAwareRetry(undefined).retry(2, failure)).toBe(true);
    expect(rateLimitAwareRetry(undefined).retry(3, failure)).toBe(false);
  });

  it("waits the advertised Retry-After, bounded to a minute", () => {
    const policy = rateLimitAwareRetry(1);
    expect(policy.retryDelay(0, limited(7))).toBe(7_000);
    expect(policy.retryDelay(0, limited(3_600))).toBe(60_000);
    expect(policy.retryDelay(2, limited(null))).toBe(4_000);
  });
});
