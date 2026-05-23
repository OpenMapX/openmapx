import type { Logger, ProviderHealthHandle } from "@openmapx/integration-framework";
import type Redis from "ioredis";

/**
 * Per-call outcome record kept in the sliding window. `at` is an ISO string
 * so the serialized state remains human-debuggable in `redis-cli`.
 */
export interface ProviderHealthCall {
  outcome: "ok" | "error";
  at: string;
  latencyMs: number;
}

export interface ProviderHealthState {
  /** Total successes since first record (never reset by the sliding window). */
  success: number;
  /** Total failures since first record. */
  failure: number;
  /** ISO 8601 of the most recent failure. */
  lastFailureAt?: string;
  /** Short reason (truncated to 200 chars) from the most recent failure. */
  lastFailureReason?: string;
  /** Exponential moving average of latency in ms. */
  emaLatencyMs: number;
  /** Sliding window of recent call outcomes, capped at `windowSize`. */
  window: ProviderHealthCall[];
  /** Computed at read time: failure rate over the window (0-1). */
  windowFailureRate?: number;
  /** Set while the provider is auto-disabled (cooldown). */
  disabledUntil?: string;
  /** Reason for the most recent disable. */
  disabledReason?: string;
}

export interface ProviderHealthOptions {
  /**
   * Redis client used as the source of truth. Required — there is no in-memory
   * fallback — every state read goes through Redis.
   */
  redis: Redis;
  /** Logger used for cooldown-emit messages. */
  log?: Logger;
  /** Cooldown duration in ms. Default 5 minutes. */
  cooldownMs?: number;
  /** Max entries in the sliding window. Default 100. */
  windowSize?: number;
  /** Failure-rate threshold above which we auto-disable. Default 0.5 (50%). */
  failureRateThreshold?: number;
  /** Minimum window size before auto-disable is allowed. Default 10. */
  minSampleSize?: number;
  /** EMA smoothing factor. Default 0.2. */
  emaAlpha?: number;
  /** TTL (seconds) applied on every write. Default 30 days. */
  ttlSeconds?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

const REDIS_PREFIX = "provider:health:";
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_SIZE = 100;
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_MIN_SAMPLE_SIZE = 10;
const DEFAULT_EMA_ALPHA = 0.2;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const REASON_TRUNCATE = 200;

/**
 * Lua script that atomically reads-modifies-writes a single
 * `provider:health:<id>` key. Implements:
 *
 *   - sliding-window push (capped at windowSize),
 *   - cumulative success/failure counters,
 *   - EMA latency,
 *   - auto-disable when failure rate > threshold AND window >= minSampleSize,
 *   - TTL refresh on every write.
 *
 * Keys: KEYS[1] = full Redis key.
 * Argv: 1=op ("ok"|"err"), 2=latencyMs, 3=nowIso, 4=reason,
 *       5=windowSize, 6=cooldownMs, 7=cooldownUntilIso,
 *       8=threshold, 9=minSampleSize, 10=emaAlpha, 11=ttlSeconds.
 *
 * Returns the post-write state JSON (the Lua-side does NOT compute
 * windowFailureRate; the TS layer adds that on read).
 */
const HEALTH_SCRIPT = `
local key = KEYS[1]
local op = ARGV[1]
local latencyMs = tonumber(ARGV[2])
local nowIso = ARGV[3]
local reason = ARGV[4]
local windowSize = tonumber(ARGV[5])
local cooldownMs = tonumber(ARGV[6])
local cooldownUntilIso = ARGV[7]
local threshold = tonumber(ARGV[8])
local minSampleSize = tonumber(ARGV[9])
local emaAlpha = tonumber(ARGV[10])
local ttlSeconds = tonumber(ARGV[11])

local raw = redis.call('GET', key)
local state
if raw then
  state = cjson.decode(raw)
else
  state = { success = 0, failure = 0, emaLatencyMs = 0, window = {} }
end

if state.window == nil then state.window = {} end

if op == 'ok' then
  state.success = (state.success or 0) + 1
  table.insert(state.window, { outcome = 'ok', at = nowIso, latencyMs = latencyMs })
else
  state.failure = (state.failure or 0) + 1
  state.lastFailureAt = nowIso
  state.lastFailureReason = reason
  table.insert(state.window, { outcome = 'error', at = nowIso, latencyMs = latencyMs })
end

-- Cap the sliding window
while #state.window > windowSize do
  table.remove(state.window, 1)
end

-- EMA latency
if (state.emaLatencyMs or 0) == 0 then
  state.emaLatencyMs = latencyMs
else
  state.emaLatencyMs = emaAlpha * latencyMs + (1 - emaAlpha) * state.emaLatencyMs
end

-- Auto-disable check
local windowLen = #state.window
if windowLen >= minSampleSize then
  local failCount = 0
  for i = 1, windowLen do
    if state.window[i].outcome == 'error' then
      failCount = failCount + 1
    end
  end
  local rate = failCount / windowLen
  if rate > threshold then
    state.disabledUntil = cooldownUntilIso
    state.disabledReason = 'failure rate ' .. string.format('%.2f', rate) .. ' over ' .. windowLen .. ' calls'
  end
end

local encoded = cjson.encode(state)
redis.call('SET', key, encoded, 'EX', ttlSeconds)
return encoded
`;

function truncateReason(reason: string): string {
  if (reason.length <= REASON_TRUNCATE) return reason;
  return reason.slice(0, REASON_TRUNCATE);
}

function keyFor(providerId: string): string {
  return `${REDIS_PREFIX}${providerId}`;
}

function computeFailureRate(state: ProviderHealthState): number | undefined {
  const len = state.window.length;
  if (len === 0) return undefined;
  let fails = 0;
  for (const call of state.window) {
    if (call.outcome === "error") fails++;
  }
  return fails / len;
}

function annotate(state: ProviderHealthState): ProviderHealthState {
  return { ...state, windowFailureRate: computeFailureRate(state) };
}

interface RedisWithCommand extends Redis {
  providerHealthApply(
    keyCount: number,
    key: string,
    op: string,
    latencyMs: string,
    nowIso: string,
    reason: string,
    windowSize: string,
    cooldownMs: string,
    cooldownUntilIso: string,
    threshold: string,
    minSampleSize: string,
    emaAlpha: string,
    ttlSeconds: string,
  ): Promise<string>;
}

const COMMAND_NAME = "providerHealthApply";

function ensureCommandRegistered(redis: Redis): RedisWithCommand {
  const r = redis as RedisWithCommand;
  if (typeof r.providerHealthApply !== "function") {
    // ioredis@5 `defineCommand` registers a per-connection method that
    // EVALSHA-caches the Lua. This sidesteps EVALSHA-NOSCRIPT bookkeeping
    // because ioredis handles the SCRIPT LOAD → EVALSHA fallback itself.
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: HEALTH_SCRIPT });
  }
  return r;
}

/**
 * Persistent provider health tracker. The state lives in
 * Redis keyed by `provider:health:<id>`; every read goes through Redis so
 * sibling api processes see the same window.
 *
 * Writes go through a Lua script to keep the read-modify-write atomic — two
 * concurrent failure-records on the same provider must both push into the
 * window, never one overwriting the other.
 */
export class ProviderHealth implements ProviderHealthHandle {
  private readonly redis: RedisWithCommand;
  private readonly log?: Logger;
  private readonly cooldownMs: number;
  private readonly windowSize: number;
  private readonly failureRateThreshold: number;
  private readonly minSampleSize: number;
  private readonly emaAlpha: number;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  private constructor(opts: ProviderHealthOptions) {
    this.redis = ensureCommandRegistered(opts.redis);
    this.log = opts.log;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.failureRateThreshold = opts.failureRateThreshold ?? DEFAULT_FAILURE_RATE_THRESHOLD;
    this.minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
    this.emaAlpha = opts.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = opts.now ?? (() => Date.now());
  }

  static async init(opts: ProviderHealthOptions): Promise<ProviderHealth> {
    return new ProviderHealth(opts);
  }

  private async applyOp(
    providerId: string,
    op: "ok" | "err",
    latencyMs: number,
    reason: string,
  ): Promise<ProviderHealthState> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const cooldownUntilIso = new Date(nowMs + this.cooldownMs).toISOString();
    const raw = await this.redis.providerHealthApply(
      1,
      keyFor(providerId),
      op,
      String(Math.max(0, Math.round(latencyMs))),
      nowIso,
      reason,
      String(this.windowSize),
      String(this.cooldownMs),
      cooldownUntilIso,
      String(this.failureRateThreshold),
      String(this.minSampleSize),
      String(this.emaAlpha),
      String(this.ttlSeconds),
    );
    const state = JSON.parse(raw) as ProviderHealthState;
    if (!Array.isArray(state.window)) state.window = [];
    return state;
  }

  async isHealthy(providerId: string): Promise<boolean> {
    const state = await this.getState(providerId);
    if (!state) return true;
    if (!state.disabledUntil) return true;
    const expiry = Date.parse(state.disabledUntil);
    if (!Number.isFinite(expiry)) return true;
    if (expiry > this.now()) return false;
    await this.clearCooldown(providerId);
    return true;
  }

  /**
   * Best-effort cooldown clear. Reads the current state and rewrites it
   * without `disabledUntil` / `disabledReason`. Race-condition risk is low
   * because the clear happens at most once per cooldown window per provider.
   */
  private async clearCooldown(providerId: string): Promise<void> {
    const raw = await this.redis.get(keyFor(providerId));
    if (!raw) return;
    let state: ProviderHealthState;
    try {
      state = JSON.parse(raw) as ProviderHealthState;
    } catch {
      return;
    }
    if (!state.disabledUntil) return;
    delete state.disabledUntil;
    delete state.disabledReason;
    await this.redis.set(keyFor(providerId), JSON.stringify(state), "EX", this.ttlSeconds);
  }

  async recordSuccess(providerId: string, latencyMs: number): Promise<void> {
    await this.applyOp(providerId, "ok", latencyMs, "");
  }

  async recordFailure(providerId: string, latencyMs: number, reason: string): Promise<void> {
    const state = await this.applyOp(providerId, "err", latencyMs, truncateReason(reason));
    if (state.disabledUntil) {
      // Was the disable set in this call? Heuristic: lastFailureAt matches
      // disabledUntil's window-start. We don't need exactness, just stop the
      // log spam from repeated already-disabled writes.
      const lastFail = state.lastFailureAt ? Date.parse(state.lastFailureAt) : 0;
      const cooldownExpiry = Date.parse(state.disabledUntil);
      if (
        Number.isFinite(lastFail) &&
        Number.isFinite(cooldownExpiry) &&
        cooldownExpiry - lastFail >= this.cooldownMs - 1000
      ) {
        this.log?.warn(
          `[provider-health] auto-disabled ${providerId} until ${state.disabledUntil} (${state.disabledReason ?? "threshold exceeded"})`,
        );
      }
    }
  }

  async getState(providerId: string): Promise<ProviderHealthState | null> {
    const raw = await this.redis.get(keyFor(providerId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ProviderHealthState;
      if (!Array.isArray(parsed.window)) parsed.window = [];
      return annotate(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Returns every provider's state, alphabetically ordered. Uses SCAN under
   * the `provider:health:*` pattern so a misbehaving Redis containing other
   * keys can't block us.
   */
  async getAll(): Promise<Record<string, ProviderHealthState>> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        `${REDIS_PREFIX}*`,
        "COUNT",
        200,
      );
      cursor = next;
      for (const k of batch) keys.push(k);
    } while (cursor !== "0");

    if (keys.length === 0) return {};

    keys.sort();
    const values = await this.redis.mget(...keys);
    const out: Record<string, ProviderHealthState> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const raw = values[i];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ProviderHealthState;
        if (!Array.isArray(parsed.window)) parsed.window = [];
        out[key.slice(REDIS_PREFIX.length)] = annotate(parsed);
      } catch {
        // skip corrupt entries
      }
    }
    return out;
  }

  async reset(providerId: string): Promise<void> {
    await this.redis.del(keyFor(providerId));
  }

  /**
   * No-op today (we don't own any timers). Kept on the surface so callers can
   * symmetrically pair `init()` with `close()`.
   */
  close(): void {
    /* no-op */
  }
}
