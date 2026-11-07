import { describe, expect, it, vi } from "vitest";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";
import { CONSUME_QUOTA_SCRIPT, RELEASE_LEASE_SCRIPT } from "../scripts";

class FakeRedis implements UpstreamRedisClient {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(): Promise<unknown> {
    throw new Error("Cache fixture must not execute lease or quota behavior");
  }
}

describe("RedisUpstreamRuntime", () => {
  it("distinguishes fresh, soft-expired, stale-if-error, and expired cache records", async () => {
    let now = 1_000;
    const runtime = createRedisUpstreamRuntime(new FakeRedis(), {
      namespace: "test",
      integrationId: "air-quality",
      now: () => now,
    });
    await runtime.write(
      "provider:cell",
      { value: 7 },
      {
        softMs: 100,
        hardMs: 200,
        staleIfErrorMs: 300,
      },
    );

    expect(await runtime.read("provider:cell")).toMatchObject({
      state: "fresh",
      value: { value: 7 },
    });
    now = 1_101;
    expect(await runtime.read("provider:cell")).toMatchObject({
      state: "stale",
      value: { value: 7 },
    });
    now = 1_201;
    expect(await runtime.read("provider:cell")).toMatchObject({
      state: "stale-if-error",
      value: { value: 7 },
    });
    now = 1_301;
    expect(await runtime.read("provider:cell")).toEqual({ state: "miss" });
  });

  it("sends refresh lease acquisition and exact owner-token release to Redis", async () => {
    const redis = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn(),
      eval: vi.fn(),
    };
    const runtime = createRedisUpstreamRuntime(redis, {
      namespace: "test",
      integrationId: "air-quality",
    });
    const lease = await runtime.acquireLease("refresh", 1_000);
    expect(lease?.token).toMatch(/^[a-f0-9-]{36}$/);
    const key = redis.set.mock.calls[0][0];
    expect(key).toMatch(/^upstream:test:air-quality:lease:[a-f0-9]{64}$/);
    expect(redis.set).toHaveBeenCalledExactlyOnceWith(key, lease?.token, "PX", 1_000, "NX");
    redis.eval.mockResolvedValue(0);
    await runtime.releaseLease("refresh", "not-owner");
    redis.eval.mockResolvedValue(1);
    await runtime.releaseLease("refresh", lease?.token ?? "");
    expect(redis.eval.mock.calls).toEqual([
      [RELEASE_LEASE_SCRIPT, 1, key, "not-owner"],
      [RELEASE_LEASE_SCRIPT, 1, key, lease?.token],
    ]);
  });

  it("sends every quota window and maps decisions while rotating only elapsed period keys", async () => {
    let now = 10_000;
    const redis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({ allowed: true, remaining: [1, 1_751], retryAt: null }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ allowed: false, remaining: [1, 1_751], retryAt: 60_000 }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ allowed: true, remaining: [48, 1_749], retryAt: null }),
        ),
    };
    const runtime = createRedisUpstreamRuntime(redis, {
      namespace: "test",
      integrationId: "air-quality",
      now: () => now,
    });
    const windows = [
      { id: "minute", limit: 50, durationMs: 60_000 },
      { id: "hour", limit: 1_800, durationMs: 3_600_000 },
    ] as const;
    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 49, windows })).toEqual({
      allowed: true,
      remaining: { minute: 1, hour: 1_751 },
      retryAt: null,
    });
    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 2, windows })).toEqual({
      allowed: false,
      remaining: { minute: 1, hour: 1_751 },
      retryAt: 60_000,
    });
    now = 60_001;
    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 2, windows })).toEqual({
      allowed: true,
      remaining: { minute: 48, hour: 1_749 },
      retryAt: null,
    });
    const calls = redis.eval.mock.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call[0]).toBe(CONSUME_QUOTA_SCRIPT);
      expect(call[1]).toBe(2);
      expect(
        call
          .slice(2, 4)
          .every((key: string) => /^upstream:test:air-quality:quota:[a-f0-9]{64}$/.test(key)),
      ).toBe(true);
    }
    expect(calls.map((call) => call.slice(4))).toEqual([
      ["49", "10000", "50", "60000", "1800", "3600000"],
      ["2", "10000", "50", "60000", "1800", "3600000"],
      ["2", "60001", "50", "60000", "1800", "3600000"],
    ]);
    expect(calls[1].slice(2, 4)).toEqual(calls[0].slice(2, 4));
    expect(calls[2][2]).not.toBe(calls[0][2]);
    expect(calls[2][3]).toBe(calls[0][3]);
  });
});
