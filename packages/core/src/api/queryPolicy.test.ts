import { afterEach, describe, expect, it } from "vitest";
import {
  configureOfflineQueryRetention,
  DETAIL_QUERY_POLICY,
  MAP_QUERY_POLICY,
  OFFLINE_RETENTION_GC_TIME_MS,
  RAPID_QUERY_POLICY,
} from "./queryPolicy";

afterEach(() => configureOfflineQueryRetention(false));

describe("query policies", () => {
  it("report short in-memory retention by default", () => {
    expect(RAPID_QUERY_POLICY.gcTime).toBeLessThan(MAP_QUERY_POLICY.gcTime);
    expect(MAP_QUERY_POLICY.gcTime).toBeLessThan(DETAIL_QUERY_POLICY.gcTime);
    expect(DETAIL_QUERY_POLICY.gcTime).toBeLessThan(OFFLINE_RETENTION_GC_TIME_MS);
  });

  it("switch every policy to offline retention when the host enables it", () => {
    configureOfflineQueryRetention(true);
    for (const policy of [RAPID_QUERY_POLICY, MAP_QUERY_POLICY, DETAIL_QUERY_POLICY]) {
      expect(policy.gcTime).toBe(OFFLINE_RETENTION_GC_TIME_MS);
    }
    configureOfflineQueryRetention(false);
    expect(DETAIL_QUERY_POLICY.gcTime).toBe(15 * 60_000);
  });
});
