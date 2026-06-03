import type Redis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHealth, type ProviderHealthState } from "../index.js";

/**
 * In-memory Redis fake. Implements only the surface ProviderHealth touches:
 *
 *   - GET / SET (with EX) / DEL
 *   - SCAN (single batch when COUNT is large enough)
 *   - MGET
 *   - defineCommand → registers a method that re-evaluates the Lua script in JS
 *     via a hand-rolled interpreter for the specific HEALTH_SCRIPT semantics
 *
 * We deliberately reimplement the script's semantics in TS so the tests don't
 * shell out to a real Redis. The TS reimplementation is kept tight: any state
 * shape mismatch between Lua and TS would surface as soon as ProviderHealth
 * reads the JSON back.
 */
class FakeRedis {
  private store = new Map<string, string>();
  private commands = new Map<string, { numberOfKeys: number; lua: string }>();

  defineCommand(name: string, opts: { numberOfKeys: number; lua: string }): void {
    this.commands.set(name, opts);
    (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
      this.runCommand(name, args);
  }

  async runCommand(_name: string, args: unknown[]): Promise<string> {
    // Mirrors ioredis `defineCommand({ numberOfKeys: 1 })`: the method is called
    // as (key, ...ARGV) — ioredis injects the key count, callers never pass it.
    //   [key, op, latencyMs, nowIso, reason,
    //    windowSize, cooldownMs, cooldownUntilIso,
    //    threshold, minSampleSize, emaAlpha, ttlSeconds]
    const [
      key,
      op,
      latencyMs,
      nowIso,
      reason,
      windowSize,
      ,
      cooldownUntilIso,
      threshold,
      minSampleSize,
      emaAlpha,
      ttlSeconds,
    ] = args as string[];

    const raw = this.store.get(key);
    let state: ProviderHealthState;
    if (raw) {
      state = JSON.parse(raw) as ProviderHealthState;
      if (!Array.isArray(state.window)) state.window = [];
    } else {
      state = { success: 0, failure: 0, emaLatencyMs: 0, window: [] };
    }

    const latency = Number(latencyMs);
    const winSize = Number(windowSize);

    if (op === "ok") {
      state.success += 1;
      state.window.push({ outcome: "ok", at: nowIso, latencyMs: latency });
    } else {
      state.failure += 1;
      state.lastFailureAt = nowIso;
      state.lastFailureReason = reason;
      state.window.push({ outcome: "error", at: nowIso, latencyMs: latency });
    }

    while (state.window.length > winSize) state.window.shift();

    const alpha = Number(emaAlpha);
    if ((state.emaLatencyMs ?? 0) === 0) {
      state.emaLatencyMs = latency;
    } else {
      state.emaLatencyMs = alpha * latency + (1 - alpha) * state.emaLatencyMs;
    }

    const minSamples = Number(minSampleSize);
    const thresholdNum = Number(threshold);
    if (state.window.length >= minSamples) {
      const fails = state.window.reduce((acc, c) => acc + (c.outcome === "error" ? 1 : 0), 0);
      const rate = fails / state.window.length;
      if (rate > thresholdNum) {
        state.disabledUntil = cooldownUntilIso;
        state.disabledReason = `failure rate ${rate.toFixed(2)} over ${state.window.length} calls`;
      }
    }

    // TTL is currently ignored by the fake — tests don't need expiry.
    void ttlSeconds;
    const encoded = JSON.stringify(state);
    this.store.set(key, encoded);
    return encoded;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n += 1;
    }
    return n;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async scan(
    _cursor: string,
    _matchKw: string,
    pattern: string,
    _countKw: string,
    _count: number,
  ): Promise<[string, string[]]> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    const keys = Array.from(this.store.keys()).filter((k) => regex.test(k));
    return ["0", keys];
  }
}

function createRedis(): Redis {
  return new FakeRedis() as unknown as Redis;
}

/** A redis whose health-store command always rejects, to test best-effort recording. */
function createThrowingRedis(): Redis {
  const base = new FakeRedis();
  (base as unknown as Record<string, unknown>).providerHealthApply = () =>
    Promise.reject(new Error("redis down"));
  return base as unknown as Redis;
}

describe("ProviderHealth", () => {
  let nowMs = 1_700_000_000_000;
  const advance = (ms: number) => {
    nowMs += ms;
  };

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts healthy for unseen providers", async () => {
    const ph = await ProviderHealth.init({ redis: createRedis(), now: () => nowMs });
    expect(await ph.isHealthy("acme")).toBe(true);
    expect(await ph.getState("acme")).toBeNull();
  });

  it("never throws when the health store is unavailable (best-effort recording)", async () => {
    const ph = await ProviderHealth.init({ redis: createThrowingRedis(), now: () => nowMs });
    await expect(ph.recordSuccess("acme", 100)).resolves.toBeUndefined();
    await expect(ph.recordFailure("acme", 50, "boom")).resolves.toBeUndefined();
  });

  it("records successes and failures with EMA latency", async () => {
    const ph = await ProviderHealth.init({ redis: createRedis(), now: () => nowMs });
    await ph.recordSuccess("acme", 100);
    await ph.recordSuccess("acme", 200);
    await ph.recordFailure("acme", 50, "timeout");

    const s = await ph.getState("acme");
    expect(s).toBeTruthy();
    expect(s?.success).toBe(2);
    expect(s?.failure).toBe(1);
    expect(s?.window).toHaveLength(3);
    expect(s?.lastFailureReason).toBe("timeout");
    // EMA: 100 → (0.2*200 + 0.8*100) = 120 → (0.2*50 + 0.8*120) = 106
    expect(s?.emaLatencyMs).toBeCloseTo(106, 1);
    expect(s?.windowFailureRate).toBeCloseTo(1 / 3, 5);
  });

  it("caps the sliding window at the configured size", async () => {
    const ph = await ProviderHealth.init({
      redis: createRedis(),
      windowSize: 5,
      now: () => nowMs,
    });
    for (let i = 0; i < 12; i++) await ph.recordSuccess("acme", 10);
    const s = await ph.getState("acme");
    expect(s?.window).toHaveLength(5);
    expect(s?.success).toBe(12);
  });

  it("auto-disables when failure rate exceeds threshold AND sample size met", async () => {
    const ph = await ProviderHealth.init({
      redis: createRedis(),
      minSampleSize: 4,
      failureRateThreshold: 0.5,
      cooldownMs: 60_000,
      now: () => nowMs,
    });

    // 3 failures, 1 success — under min sample size, no disable yet
    await ph.recordFailure("acme", 10, "boom");
    await ph.recordFailure("acme", 10, "boom");
    await ph.recordFailure("acme", 10, "boom");
    expect(await ph.isHealthy("acme")).toBe(true);

    // 4th call brings us to min sample size and rate > 0.5
    await ph.recordFailure("acme", 10, "boom");
    const s = await ph.getState("acme");
    expect(s?.disabledUntil).toBeDefined();
    expect(s?.disabledReason).toContain("failure rate");
    expect(await ph.isHealthy("acme")).toBe(false);
  });

  it("respects minSampleSize before disabling", async () => {
    const ph = await ProviderHealth.init({
      redis: createRedis(),
      minSampleSize: 20,
      failureRateThreshold: 0.5,
      now: () => nowMs,
    });
    // 100% failures but only 5 calls
    for (let i = 0; i < 5; i++) await ph.recordFailure("acme", 10, "boom");
    expect(await ph.isHealthy("acme")).toBe(true);
    const s = await ph.getState("acme");
    expect(s?.disabledUntil).toBeUndefined();
  });

  it("re-enables after cooldown expires", async () => {
    const ph = await ProviderHealth.init({
      redis: createRedis(),
      minSampleSize: 3,
      failureRateThreshold: 0.5,
      cooldownMs: 60_000,
      now: () => nowMs,
    });
    for (let i = 0; i < 4; i++) await ph.recordFailure("acme", 10, "boom");
    expect(await ph.isHealthy("acme")).toBe(false);

    advance(120_000); // 2 minutes — past cooldown
    expect(await ph.isHealthy("acme")).toBe(true);
    // The cooldown clear should have removed disabledUntil from the state too.
    const s = await ph.getState("acme");
    expect(s?.disabledUntil).toBeUndefined();
  });

  it("truncates failure reasons to 200 chars", async () => {
    const ph = await ProviderHealth.init({ redis: createRedis(), now: () => nowMs });
    const longReason = "x".repeat(500);
    await ph.recordFailure("acme", 0, longReason);
    const s = await ph.getState("acme");
    expect(s?.lastFailureReason?.length).toBe(200);
  });

  it("getAll returns providers in alphabetical order", async () => {
    const ph = await ProviderHealth.init({ redis: createRedis(), now: () => nowMs });
    await ph.recordSuccess("zeta", 10);
    await ph.recordSuccess("alpha", 10);
    await ph.recordSuccess("mu", 10);
    const all = await ph.getAll();
    expect(Object.keys(all)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("reset clears a provider's state", async () => {
    const ph = await ProviderHealth.init({ redis: createRedis(), now: () => nowMs });
    await ph.recordFailure("acme", 10, "boom");
    expect(await ph.getState("acme")).toBeTruthy();
    await ph.reset("acme");
    expect(await ph.getState("acme")).toBeNull();
  });

  it("EMA latency converges towards a steady-state value", async () => {
    const ph = await ProviderHealth.init({
      redis: createRedis(),
      emaAlpha: 0.2,
      now: () => nowMs,
    });
    // First call seeds EMA at 1000ms, then 50 calls at 100ms should pull it close to 100ms.
    await ph.recordSuccess("acme", 1000);
    for (let i = 0; i < 50; i++) await ph.recordSuccess("acme", 100);
    const s = await ph.getState("acme");
    expect(s?.emaLatencyMs).toBeGreaterThan(99);
    expect(s?.emaLatencyMs).toBeLessThan(110);
  });
});
