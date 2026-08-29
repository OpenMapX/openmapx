import { describe, expect, it } from "vitest";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";

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

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys);
    const argv = args.slice(numberOfKeys);
    if (script.includes("openmapx-release-lease")) {
      if (this.values.get(keys[0] ?? "") !== argv[0]) return 0;
      return this.del(keys[0] ?? "");
    }
    if (script.includes("openmapx-consume-quota")) {
      const cost = Number(argv[0]);
      const now = Number(argv[1]);
      const windows = keys.map((key, index) => ({
        key,
        limit: Number(argv[2 + index * 2]),
        durationMs: Number(argv[3 + index * 2]),
      }));
      const denied = windows.filter(
        ({ key, limit }) => Number(this.values.get(key) ?? "0") + cost > limit,
      );
      const allowed = denied.length === 0;
      if (allowed) {
        for (const { key } of windows) {
          this.values.set(key, String(Number(this.values.get(key) ?? "0") + cost));
        }
      }
      return JSON.stringify({
        allowed,
        remaining: windows.map(({ key, limit }) =>
          Math.max(0, limit - Number(this.values.get(key) ?? "0")),
        ),
        retryAt: allowed
          ? null
          : Math.max(
              ...denied.map(({ durationMs }) => (Math.floor(now / durationMs) + 1) * durationMs),
            ),
      });
    }
    throw new Error("unknown script");
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

  it("leases refreshes and releases only for the owning token", async () => {
    const runtime = createRedisUpstreamRuntime(new FakeRedis(), {
      namespace: "test",
      integrationId: "air-quality",
    });
    const lease = await runtime.acquireLease("refresh", 1_000);
    expect(lease).not.toBeNull();
    expect(await runtime.acquireLease("refresh", 1_000)).toBeNull();
    await runtime.releaseLease("refresh", "not-owner");
    expect(await runtime.acquireLease("refresh", 1_000)).toBeNull();
    await runtime.releaseLease("refresh", lease?.token ?? "");
    expect(await runtime.acquireLease("refresh", 1_000)).not.toBeNull();
  });

  it("consumes every quota window atomically and returns retry time", async () => {
    let now = 10_000;
    const redis = new FakeRedis();
    const runtime = createRedisUpstreamRuntime(redis, {
      namespace: "test",
      integrationId: "air-quality",
      now: () => now,
    });
    const windows = [
      { id: "minute", limit: 50, durationMs: 60_000 },
      { id: "hour", limit: 1_800, durationMs: 3_600_000 },
    ] as const;

    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 49, windows })).toMatchObject({
      allowed: true,
      remaining: { minute: 1, hour: 1_751 },
    });
    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 2, windows })).toMatchObject({
      allowed: false,
      retryAt: 60_000,
      remaining: { minute: 1, hour: 1_751 },
    });
    now = 60_001;
    expect(await runtime.consumeQuota({ bucket: "openaq", cost: 2, windows })).toMatchObject({
      allowed: true,
      remaining: { minute: 48, hour: 1_749 },
    });
  });
});
