import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { ProviderHealth, type ProviderHealthState } from "../index.js";

class FakeRedis {
  readonly store = new Map<string, string>();

  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = async () => "";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    if (args.includes("NX") && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    return keys.reduce((count, key) => count + (this.store.delete(key) ? 1 : 0), 0);
  }

  async scan(): Promise<[string, string[]]> {
    return ["0", [...this.store.keys()].filter((key) => key.startsWith("provider:health:"))];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.store.get(key) ?? null);
  }
}

function asRedis(fake = new FakeRedis()): Redis {
  return fake as unknown as Redis;
}

describe("ProviderHealth", () => {
  it("fails open with a diagnostic when Redis reads fail", async () => {
    const redis = asRedis();
    redis.get = async () => {
      throw new Error("down");
    };
    const health = await ProviderHealth.init({ redis });
    await expect(health.getSnapshot("acme")).resolves.toMatchObject({
      state: "healthy",
      diagnostic: "store_unavailable",
    });
    await expect(health.isHealthy("acme")).resolves.toBe(true);
  });

  it("peeks in batches without leasing a half-open probe", async () => {
    let now = 1_700_000_000_000;
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({
      redis: asRedis(redis),
      now: () => now,
      cooldownsMs: [1],
    });
    const stored: ProviderHealthState = {
      schema: 2,
      state: "open",
      successCount: 0,
      failureCount: 5,
      countedFailureCount: 5,
      consecutiveSuccesses: 0,
      consecutiveFailures: 5,
      reopenCount: 0,
      emaLatencyMs: 10,
      window: [{ outcome: "error", at: new Date(now).toISOString(), latencyMs: 10 }],
      lastSuccessAt: null,
      lastFailureAt: new Date(now).toISOString(),
      lastFailureOutcome: "timeout",
      lastOperatorMessage: "",
      retryAt: new Date(now + 1).toISOString(),
    };
    redis.store.set("provider:health:open", JSON.stringify(stored));
    now += 2;

    const before = new Map(redis.store);
    const peeked = await health.peekMany(["open", "missing"]);
    expect(peeked.get("open")).toMatchObject({
      providerId: "open",
      status: "observed",
      snapshot: { state: "open", ownsHalfOpenProbe: false },
    });
    expect(peeked.get("missing")).toEqual({ providerId: "missing", status: "unobserved" });
    expect(redis.store).toEqual(before);
  });

  it("accepts the empty-object window that Lua encodes but rejects other non-array windows", async () => {
    const redis = new FakeRedis();
    const stored = {
      schema: 2,
      state: "healthy",
      successCount: 0,
      failureCount: 1,
      countedFailureCount: 0,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      reopenCount: 0,
      emaLatencyMs: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureOutcome: "caller_cancelled",
      lastOperatorMessage: "cancelled by caller",
      retryAt: null,
    };
    redis.store.set("provider:health:empty", JSON.stringify({ ...stored, window: {} }));
    redis.store.set(
      "provider:health:keyed",
      JSON.stringify({ ...stored, window: { 0: { outcome: "error" } } }),
    );
    redis.store.set("provider:health:text", JSON.stringify({ ...stored, window: "none" }));
    redis.store.set("provider:health:null", JSON.stringify({ ...stored, window: null }));
    const health = await ProviderHealth.init({ redis: asRedis(redis) });

    const peeked = await health.peekMany(["empty", "keyed", "text", "null"]);
    expect(peeked.get("empty")).toMatchObject({
      status: "observed",
      snapshot: { state: "healthy", failureCount: 1, windowFailureRate: null },
    });
    for (const id of ["keyed", "text", "null"])
      expect(peeked.get(id)).toEqual({ providerId: id, status: "invalid-record" });
    await expect(health.getSnapshot("keyed")).resolves.toMatchObject({
      diagnostic: "invalid_record",
    });
    await expect(health.getSnapshot("empty")).resolves.toMatchObject({
      failureCount: 1,
      lastOperatorMessage: "cancelled by caller",
    });
  });

  it("distinguishes invalid and unavailable provider-health records", async () => {
    const redis = new FakeRedis();
    redis.store.set("provider:health:bad", "not-json");
    const health = await ProviderHealth.init({ redis: asRedis(redis) });
    await expect(health.peekMany(["bad"])).resolves.toEqual(
      new Map([["bad", { providerId: "bad", status: "invalid-record" }]]),
    );

    redis.mget = async () => {
      throw new Error("redis unavailable");
    };
    await expect(health.peekMany(["bad", "missing"])).resolves.toEqual(
      new Map([
        ["bad", { providerId: "bad", status: "store-unavailable" }],
        ["missing", { providerId: "missing", status: "store-unavailable" }],
      ]),
    );
  });
});
