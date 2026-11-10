import { afterEach, describe, expect, it } from "vitest";
import { ApiClientError } from "./client";
import {
  configureOfflineQueryRetention,
  DETAIL_QUERY_POLICY,
  MAP_QUERY_POLICY,
  OFFLINE_RETENTION_GC_TIME_MS,
  RAPID_QUERY_POLICY,
  RATE_LIMIT_AWARE_RETRY,
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

  it("retries a 429 up to five times and anything else once", () => {
    expect([0, 4, 5].map((count) => RATE_LIMIT_AWARE_RETRY.retry(count, limited(2)))).toEqual([
      true,
      true,
      false,
    ]);
    const failure = new ApiClientError(502, null, null);
    expect(RATE_LIMIT_AWARE_RETRY.retry(0, failure)).toBe(true);
    expect(RATE_LIMIT_AWARE_RETRY.retry(1, failure)).toBe(false);
  });

  it("waits the advertised Retry-After, bounded to a minute", () => {
    expect(RATE_LIMIT_AWARE_RETRY.retryDelay(0, limited(7))).toBe(7_000);
    expect(RATE_LIMIT_AWARE_RETRY.retryDelay(0, limited(3_600))).toBe(60_000);
    expect(RATE_LIMIT_AWARE_RETRY.retryDelay(2, limited(null))).toBe(4_000);
  });
});
