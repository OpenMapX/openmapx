import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { ProviderHealth, type ProviderHealthState } from "../index.js";

class FakeRedis {
  readonly store = new Map<string, string>();

  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = (...args: string[]) =>
      this.transition(args);
  }

  private async transition(args: string[]): Promise<string> {
    const [
      key,
      probeKey,
      op,
      outcome,
      latencyRaw,
      nowIso,
      ,
      message,
      windowRaw,
      minRaw,
      degradedRaw,
      openRaw,
      alphaRaw,
      ,
      cooldownRaw,
      countedRaw,
    ] = args;
    const raw = this.store.get(key as string);
    const state: ProviderHealthState = raw
      ? (JSON.parse(raw) as ProviderHealthState)
      : {
          schema: 2,
          state: "healthy",
          successCount: 0,
          failureCount: 0,
          countedFailureCount: 0,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
          reopenCount: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastFailureOutcome: null,
          lastOperatorMessage: null,
          emaLatencyMs: 0,
          window: [],
          retryAt: null,
        };
    const latency = Number(latencyRaw);
    const alpha = Number(alphaRaw);
    state.emaLatencyMs =
      state.emaLatencyMs === 0 ? latency : alpha * latency + (1 - alpha) * state.emaLatencyMs;
    if (op === "success") {
      state.successCount++;
      state.consecutiveSuccesses++;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = nowIso as string;
      state.window.push({ outcome: "ok", at: nowIso as string, latencyMs: latency });
      if (state.state === "open") {
        state.state = "degraded";
        state.retryAt = null;
      }
      if (state.consecutiveSuccesses >= 3) {
        state.state = "healthy";
        state.reopenCount = 0;
        state.retryAt = null;
      }
    } else {
      state.failureCount++;
      state.lastFailureAt = nowIso as string;
      state.lastFailureOutcome = outcome as ProviderHealthState["lastFailureOutcome"];
      state.lastOperatorMessage = message as string;
      if (countedRaw === "1") {
        state.countedFailureCount++;
        state.consecutiveFailures++;
        state.consecutiveSuccesses = 0;
        state.window.push({ outcome: "error", at: nowIso as string, latencyMs: latency });
        const failures = state.window.filter((entry) => entry.outcome === "error").length;
        const rate = failures / state.window.length;
        if (
          state.consecutiveFailures >= 5 ||
          (state.window.length >= Number(minRaw) && rate > Number(openRaw))
        ) {
          if (state.state === "open") state.reopenCount++;
          const cooldowns = JSON.parse(cooldownRaw as string) as string[];
          const cooldown = cooldowns[Math.min(state.reopenCount, cooldowns.length - 1)] as string;
          state.state = "open";
          state.retryAt = cooldown;
        } else if (
          state.consecutiveFailures >= 2 ||
          (state.window.length >= 4 && rate >= Number(degradedRaw))
        ) {
          state.state = "degraded";
        }
      }
    }
    while (state.window.length > Number(windowRaw)) state.window.shift();
    this.store.delete(probeKey as string);
    const encoded = JSON.stringify(state);
    this.store.set(key as string, encoded);
    return encoded;
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
  it("degrades at two consecutive counted failures and at a 25% window rate", async () => {
    const health = await ProviderHealth.init({ redis: asRedis() });
    await health.recordFailure("consecutive", 10, "timeout");
    expect((await health.getSnapshot("consecutive")).state).toBe("healthy");
    await health.recordFailure("consecutive", 10, "connection");
    expect((await health.getSnapshot("consecutive")).state).toBe("degraded");

    await health.recordSuccess("rate", 10);
    await health.recordSuccess("rate", 10);
    await health.recordSuccess("rate", 10);
    await health.recordFailure("rate", 10, "invalid_payload");
    expect((await health.getSnapshot("rate")).state).toBe("degraded");
  });

  it("opens above 50% with enough samples or at five consecutive failures", async () => {
    const health = await ProviderHealth.init({ redis: asRedis(), minSampleSize: 4 });
    await health.recordSuccess("rate", 10);
    await health.recordFailure("rate", 10, "timeout");
    await health.recordFailure("rate", 10, "timeout");
    await health.recordFailure("rate", 10, "timeout");
    expect((await health.getSnapshot("rate")).state).toBe("open");

    for (let index = 0; index < 5; index++) {
      await health.recordFailure("streak", 10, "upstream_5xx");
    }
    expect((await health.getSnapshot("streak")).state).toBe("open");
  });

  it("does not count valid empty, policy, input, quota, or caller cancellation", async () => {
    const health = await ProviderHealth.init({ redis: asRedis() });
    for (const outcome of [
      "valid_empty",
      "policy",
      "input",
      "quota",
      "caller_cancelled",
    ] as const) {
      await health.recordFailure("safe", 10, outcome, "operator detail");
    }
    const snapshot = await health.getSnapshot("safe");
    expect(snapshot).toMatchObject({ state: "healthy", failureCount: 5, countedFailureCount: 0 });
    expect(snapshot.lastOperatorMessage).toBe("operator detail");
  });

  it("leases one half-open probe, escalates cooldowns, and recovers after three successes", async () => {
    let now = 1_700_000_000_000;
    const redis = new FakeRedis();
    const options = {
      redis: asRedis(redis),
      now: () => now,
      cooldownsMs: [100, 200, 400, 800, 1_600],
    };
    const first = await ProviderHealth.init(options);
    const second = await ProviderHealth.init(options);
    for (let index = 0; index < 5; index++) await first.recordFailure("acme", 10, "timeout");
    const initial = await first.getSnapshot("acme");
    expect(Date.parse(initial.retryAt as string) - now).toBe(100);

    now += 101;
    expect(await first.isHealthy("acme")).toBe(true);
    expect(await second.isHealthy("acme")).toBe(false);
    await first.recordFailure("acme", 10, "timeout");
    const reopened = await first.getSnapshot("acme");
    expect(Date.parse(reopened.retryAt as string) - now).toBe(200);

    now += 201;
    expect(await first.isHealthy("acme")).toBe(true);
    await first.recordSuccess("acme", 20);
    expect((await first.getSnapshot("acme")).state).toBe("degraded");
    await first.recordSuccess("acme", 20);
    await first.recordSuccess("acme", 20);
    expect((await first.getSnapshot("acme")).state).toBe("healthy");
  });

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
});
