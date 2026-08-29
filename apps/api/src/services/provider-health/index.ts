import type {
  Logger,
  ProviderHealthFailureOutcome,
  ProviderHealthHandle,
  ProviderHealthSnapshot,
} from "@openmapx/integration-framework";
import type Redis from "ioredis";

export interface ProviderHealthCall {
  outcome: "ok" | "error";
  at: string;
  latencyMs: number;
}

export interface ProviderHealthState {
  schema: 2;
  state: "healthy" | "degraded" | "open";
  successCount: number;
  failureCount: number;
  countedFailureCount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  reopenCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureOutcome: ProviderHealthFailureOutcome | null;
  lastOperatorMessage: string | null;
  lastFailureReason?: string;
  emaLatencyMs: number;
  window: ProviderHealthCall[];
  retryAt: string | null;
  success?: number;
  failure?: number;
  windowFailureRate?: number;
  disabledUntil?: string;
  disabledReason?: string;
}

export interface ProviderHealthOptions {
  redis: Redis;
  log?: Logger;
  windowSize?: number;
  minSampleSize?: number;
  degradedFailureRate?: number;
  openFailureRate?: number;
  emaAlpha?: number;
  ttlSeconds?: number;
  cooldownsMs?: readonly number[];
  halfOpenLeaseMs?: number;
  now?: () => number;
}

const REDIS_PREFIX = "provider:health:";
const PROBE_PREFIX = "provider:health-probe:";
const DEFAULT_COOLDOWNS_MS = [5, 10, 20, 40, 60].map((minutes) => minutes * 60_000);
const MESSAGE_LIMIT = 200;
const COUNTED_OUTCOMES = new Set<ProviderHealthFailureOutcome>([
  "timeout",
  "connection",
  "upstream_5xx",
  "auth",
  "invalid_payload",
]);

/** Atomic state transition; the second key owns the half-open lease. */
const HEALTH_SCRIPT = `
local key = KEYS[1]
local probeKey = KEYS[2]
local op = ARGV[1]
local outcome = ARGV[2]
local latency = tonumber(ARGV[3])
local nowIso = ARGV[4]
local message = ARGV[6]
local windowSize = tonumber(ARGV[7])
local minSamples = tonumber(ARGV[8])
local degradedRate = tonumber(ARGV[9])
local openRate = tonumber(ARGV[10])
local alpha = tonumber(ARGV[11])
local ttl = tonumber(ARGV[12])
local cooldowns = cjson.decode(ARGV[13])
local counted = ARGV[14] == '1'

local raw = redis.call('GET', key)
local s
if raw then s = cjson.decode(raw) end
if (not s) or s.schema ~= 2 then
  s = { schema=2, state='healthy', successCount=0, failureCount=0,
    countedFailureCount=0, consecutiveSuccesses=0, consecutiveFailures=0,
    reopenCount=0, emaLatencyMs=0, window={} }
end
if s.window == nil then s.window = {} end
if s.emaLatencyMs == 0 then s.emaLatencyMs = latency
else s.emaLatencyMs = alpha * latency + (1-alpha) * s.emaLatencyMs end

if op == 'success' then
  s.successCount = s.successCount + 1
  s.consecutiveSuccesses = s.consecutiveSuccesses + 1
  s.consecutiveFailures = 0
  s.lastSuccessAt = nowIso
  table.insert(s.window, {outcome='ok', at=nowIso, latencyMs=latency})
  if s.state == 'open' then s.state = 'degraded'; s.retryAt = cjson.null end
  if s.consecutiveSuccesses >= 3 then
    s.state = 'healthy'; s.reopenCount = 0; s.retryAt = cjson.null
  end
else
  s.failureCount = s.failureCount + 1
  s.lastFailureAt = nowIso
  s.lastFailureOutcome = outcome
  s.lastOperatorMessage = message
  if counted then
    s.countedFailureCount = s.countedFailureCount + 1
    s.consecutiveFailures = s.consecutiveFailures + 1
    s.consecutiveSuccesses = 0
    table.insert(s.window, {outcome='error', at=nowIso, latencyMs=latency})
    local failures = 0
    for i=1,#s.window do if s.window[i].outcome == 'error' then failures=failures+1 end end
    local rate = #s.window > 0 and failures/#s.window or 0
    local shouldOpen = s.consecutiveFailures >= 5 or (#s.window >= minSamples and rate > openRate)
    if shouldOpen then
      if s.state == 'open' then s.reopenCount = s.reopenCount + 1 end
      local idx = math.min(s.reopenCount + 1, #cooldowns)
      s.state = 'open'
      s.retryAt = cooldowns[idx]
    elseif s.consecutiveFailures >= 2 or (#s.window >= 4 and rate >= degradedRate) then
      s.state = 'degraded'
    end
  end
end

while #s.window > windowSize do table.remove(s.window, 1) end
redis.call('DEL', probeKey)
local encoded = cjson.encode(s)
redis.call('SET', key, encoded, 'EX', ttl)
return encoded
`;

interface RedisWithCommand extends Redis {
  providerHealthTransition(key: string, probeKey: string, ...args: string[]): Promise<string>;
}

function ensureCommandRegistered(redis: Redis): RedisWithCommand {
  const candidate = redis as RedisWithCommand;
  if (typeof candidate.providerHealthTransition !== "function") {
    redis.defineCommand("providerHealthTransition", { numberOfKeys: 2, lua: HEALTH_SCRIPT });
  }
  return candidate;
}

function keyFor(providerId: string): string {
  return `${REDIS_PREFIX}${providerId}`;
}

function probeKeyFor(providerId: string): string {
  return `${PROBE_PREFIX}${providerId}`;
}

function failureRate(state: ProviderHealthState): number | null {
  if (state.window.length === 0) return null;
  return state.window.filter((call) => call.outcome === "error").length / state.window.length;
}

function compatibilityState(state: ProviderHealthState): ProviderHealthState {
  const rate = failureRate(state);
  return {
    ...state,
    success: state.successCount,
    failure: state.failureCount,
    windowFailureRate: rate ?? undefined,
    disabledUntil: state.state === "open" ? (state.retryAt ?? undefined) : undefined,
    disabledReason: state.state === "open" ? "provider circuit open" : undefined,
    lastFailureReason: state.lastOperatorMessage ?? undefined,
  };
}

function emptySnapshot(diagnostic?: ProviderHealthSnapshot["diagnostic"]): ProviderHealthSnapshot {
  return {
    state: "healthy",
    successCount: 0,
    failureCount: 0,
    countedFailureCount: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    windowFailureRate: null,
    emaLatencyMs: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureOutcome: null,
    lastOperatorMessage: null,
    retryAt: null,
    ownsHalfOpenProbe: false,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function parseState(raw: string): ProviderHealthState | null {
  try {
    const state = JSON.parse(raw) as ProviderHealthState;
    return state.schema === 2 && Array.isArray(state.window) ? state : null;
  } catch {
    return null;
  }
}

export class ProviderHealth implements ProviderHealthHandle {
  private readonly redis: RedisWithCommand;
  private readonly log?: Logger;
  private readonly windowSize: number;
  private readonly minSampleSize: number;
  private readonly degradedFailureRate: number;
  private readonly openFailureRate: number;
  private readonly emaAlpha: number;
  private readonly ttlSeconds: number;
  private readonly cooldownsMs: readonly number[];
  private readonly halfOpenLeaseMs: number;
  private readonly now: () => number;

  private constructor(options: ProviderHealthOptions) {
    this.redis = ensureCommandRegistered(options.redis);
    this.log = options.log;
    this.windowSize = options.windowSize ?? 100;
    this.minSampleSize = options.minSampleSize ?? 10;
    this.degradedFailureRate = options.degradedFailureRate ?? 0.25;
    this.openFailureRate = options.openFailureRate ?? 0.5;
    this.emaAlpha = options.emaAlpha ?? 0.2;
    this.ttlSeconds = options.ttlSeconds ?? 60 * 60 * 24 * 30;
    this.cooldownsMs = options.cooldownsMs ?? DEFAULT_COOLDOWNS_MS;
    this.halfOpenLeaseMs = options.halfOpenLeaseMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  static async init(options: ProviderHealthOptions): Promise<ProviderHealth> {
    return new ProviderHealth(options);
  }

  private async transition(
    providerId: string,
    op: "success" | "failure",
    latencyMs: number,
    outcome: ProviderHealthFailureOutcome | "",
    operatorMessage: string,
  ): Promise<void> {
    const at = this.now();
    try {
      await this.redis.providerHealthTransition(
        keyFor(providerId),
        probeKeyFor(providerId),
        op,
        outcome,
        String(Math.max(0, Math.round(latencyMs))),
        new Date(at).toISOString(),
        String(at),
        operatorMessage.slice(0, MESSAGE_LIMIT),
        String(this.windowSize),
        String(this.minSampleSize),
        String(this.degradedFailureRate),
        String(this.openFailureRate),
        String(this.emaAlpha),
        String(this.ttlSeconds),
        JSON.stringify(this.cooldownsMs.map((duration) => new Date(at + duration).toISOString())),
        COUNTED_OUTCOMES.has(outcome as ProviderHealthFailureOutcome) ? "1" : "0",
      );
    } catch (error) {
      this.log?.warn(
        `[provider-health] failed to record ${op} for ${providerId}: ${(error as Error).message}`,
      );
    }
  }

  async recordSuccess(providerId: string, latencyMs: number): Promise<void> {
    await this.transition(providerId, "success", latencyMs, "", "");
  }

  async recordFailure(
    providerId: string,
    latencyMs: number,
    outcome: ProviderHealthFailureOutcome,
    operatorMessage = "",
  ): Promise<void> {
    await this.transition(providerId, "failure", latencyMs, outcome, operatorMessage);
  }

  async getSnapshot(providerId: string): Promise<ProviderHealthSnapshot> {
    let raw: string | null;
    try {
      raw = await this.redis.get(keyFor(providerId));
    } catch {
      return emptySnapshot("store_unavailable");
    }
    if (!raw) return emptySnapshot();
    const stored = parseState(raw);
    if (!stored) return emptySnapshot("invalid_record");
    let state: ProviderHealthSnapshot["state"] = stored.state;
    let ownsHalfOpenProbe = false;
    const retryAtMs = stored.retryAt ? Date.parse(stored.retryAt) : Number.NaN;
    if (stored.state === "open" && Number.isFinite(retryAtMs) && retryAtMs <= this.now()) {
      try {
        ownsHalfOpenProbe =
          (await this.redis.set(
            probeKeyFor(providerId),
            String(this.now()),
            "PX",
            this.halfOpenLeaseMs,
            "NX",
          )) === "OK";
        state = ownsHalfOpenProbe ? "half-open" : "open";
      } catch {
        return emptySnapshot("store_unavailable");
      }
    }
    return {
      state,
      successCount: stored.successCount,
      failureCount: stored.failureCount,
      countedFailureCount: stored.countedFailureCount,
      consecutiveSuccesses: stored.consecutiveSuccesses,
      consecutiveFailures: stored.consecutiveFailures,
      windowFailureRate: failureRate(stored),
      emaLatencyMs: stored.emaLatencyMs,
      lastSuccessAt: stored.lastSuccessAt ?? null,
      lastFailureAt: stored.lastFailureAt ?? null,
      lastFailureOutcome: stored.lastFailureOutcome ?? null,
      lastOperatorMessage: stored.lastOperatorMessage ?? null,
      retryAt: stored.retryAt ?? null,
      ownsHalfOpenProbe,
    };
  }

  async isHealthy(providerId: string): Promise<boolean> {
    const snapshot = await this.getSnapshot(providerId);
    return snapshot.state !== "open" || snapshot.ownsHalfOpenProbe;
  }

  async getState(providerId: string): Promise<ProviderHealthState | null> {
    try {
      const raw = await this.redis.get(keyFor(providerId));
      if (!raw) return null;
      const state = parseState(raw);
      return state ? compatibilityState(state) : null;
    } catch {
      return null;
    }
  }

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
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return {};
    keys.sort();
    const values = await this.redis.mget(...keys);
    const result: Record<string, ProviderHealthState> = {};
    for (let index = 0; index < keys.length; index++) {
      const raw = values[index];
      if (!raw) continue;
      const state = parseState(raw);
      if (state)
        result[(keys[index] as string).slice(REDIS_PREFIX.length)] = compatibilityState(state);
    }
    return result;
  }

  async reset(providerId: string): Promise<void> {
    await this.redis.del(keyFor(providerId), probeKeyFor(providerId));
  }

  close(): void {}
}
