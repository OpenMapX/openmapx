import {
  createLocalQuotaMeter,
  type SharedRequestDecision,
  type SharedRequestPolicy,
} from "@openmapx/integration-framework";
import { redis } from "../redis.js";
import type { UpstreamRedisClient } from "./upstream-runtime/index.js";
import { createSharedAdmission } from "./upstream-runtime/shared-admission.js";

const DAY_MS = 86_400_000;
const STORE_UNAVAILABLE_RETRY_SECONDS = 30;

export type ProviderBudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 429 | 503;
      retryAfterSeconds: number;
      /** True for the first refusal of a spent budget in its window, so it is logged once. */
      firstRefusalInWindow: boolean;
    };

export interface ProviderDailyBudget {
  admit(signal?: AbortSignal): Promise<ProviderBudgetDecision>;
}

interface SharedAdmission {
  admitSharedRequest(input: {
    scope: string;
    key: string;
    policy?: SharedRequestPolicy;
    signal?: AbortSignal;
  }): Promise<SharedRequestDecision>;
}

/**
 * A daily request budget for one key-bearing upstream, shared by every client
 * and every API replica through the upstream runtime's shared admission. It
 * bounds what the operator's key can be made to spend, whatever the number of
 * client addresses involved; per-client limits alone cannot.
 *
 * Without a shared store (a development checkout with no Valkey) nothing is
 * metered. With a store configured but unreachable, `whenStoreUnavailable`
 * decides: `refuse` answers 503, and `meter-locally` counts the same daily
 * budget in this process (each replica then admits up to the full budget).
 * Either way a store failure never becomes unmetered use of a paid key.
 */
export function createProviderDailyBudget(options: {
  provider: string;
  limit: number;
  admission: SharedAdmission | null;
  whenStoreUnavailable: "refuse" | "meter-locally";
}): ProviderDailyBudget {
  const policy: SharedRequestPolicy = {
    id: "daily",
    limit: options.limit,
    durationMs: DAY_MS,
    minIntervalMs: 0,
  };
  const localMeter = createLocalQuotaMeter({ maxCounters: 1 });
  let warnedUntil = 0;

  const spent = (retryAfterMs: number): ProviderBudgetDecision => {
    const now = Date.now();
    const firstRefusalInWindow = now >= warnedUntil;
    if (firstRefusalInWindow) warnedUntil = now + retryAfterMs;
    return {
      allowed: false,
      status: 429,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      firstRefusalInWindow,
    };
  };

  return {
    async admit(signal) {
      if (!options.admission) return { allowed: true };
      const decision = await options.admission.admitSharedRequest({
        scope: "provider-daily-budget",
        key: options.provider,
        policy,
        ...(signal ? { signal } : {}),
      });
      if (decision.allowed) return { allowed: true };
      if (decision.reason !== "store_unavailable") return spent(decision.retryAfterMs ?? 60_000);
      if (options.whenStoreUnavailable === "refuse") {
        return {
          allowed: false,
          status: 503,
          retryAfterSeconds: STORE_UNAVAILABLE_RETRY_SECONDS,
          firstRefusalInWindow: false,
        };
      }
      const local = localMeter.consume({
        bucket: options.provider,
        cost: 1,
        windows: [{ id: "daily", limit: options.limit, durationMs: DAY_MS }],
      });
      if (local.allowed) return { allowed: true };
      return spent((local.retryAt ?? Date.now() + 60_000) - Date.now());
    },
  };
}

/** A positive integer from the environment, or undefined when unset, zero or invalid. */
function dailyLimit(name: string): number | undefined {
  const raw = Number(process.env[name]?.trim());
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

let sharedAdmission: SharedAdmission | null | undefined;

function configuredSharedAdmission(): SharedAdmission | null {
  if (sharedAdmission === undefined) {
    sharedAdmission = redis
      ? createSharedAdmission(
          redis as unknown as UpstreamRedisClient,
          process.env.OPENMAPX_UPSTREAM_NAMESPACE?.trim() || "default",
        )
      : null;
  }
  return sharedAdmission;
}

/**
 * TomTom's free tier allows 50,000 tile requests a day. Traffic is an optional
 * overlay, so an unreachable store refuses tiles rather than risk the key.
 */
export function tomtomTrafficDailyBudget(): ProviderDailyBudget {
  return createProviderDailyBudget({
    provider: "tomtom-traffic",
    limit: dailyLimit("TOMTOM_TRAFFIC_DAILY_REQUEST_LIMIT") ?? 50_000,
    admission: configuredSharedAdmission(),
    whenStoreUnavailable: "refuse",
  });
}

/**
 * MapTiler can serve the whole basemap (tiles, glyphs, sprites, satellite and
 * terrain), so a global cap stops the map for everyone. It is therefore off
 * unless the operator sets `MAPTILER_DAILY_REQUEST_LIMIT`; the per-client tile
 * tier always applies. A configured budget keeps the map working while the
 * store is unreachable by counting in process.
 */
export function maptilerDailyBudget(): ProviderDailyBudget | null {
  const limit = dailyLimit("MAPTILER_DAILY_REQUEST_LIMIT");
  if (limit === undefined) return null;
  return createProviderDailyBudget({
    provider: "maptiler",
    limit,
    admission: configuredSharedAdmission(),
    whenStoreUnavailable: "meter-locally",
  });
}

/**
 * The 429 or 503 a refused provider request answers with. A spent budget is
 * logged once per window, not once per refused request.
 */
export function sendProviderBudgetRefusal(
  reply: {
    header(name: string, value: string): unknown;
    status(code: number): { send(payload: unknown): unknown };
  },
  decision: Exclude<ProviderBudgetDecision, { allowed: true }>,
  provider: string,
  log: { warn(fields: Record<string, unknown>, message: string): void },
) {
  if (decision.firstRefusalInWindow) {
    log.warn(
      {
        event: "provider.daily-budget-spent",
        provider,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      "Provider daily request budget is spent; requests are refused until it resets",
    );
  }
  reply.header("Cache-Control", "no-store");
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  return reply.status(decision.status).send({
    message:
      decision.status === 429
        ? `${provider} has used its daily request budget`
        : `${provider} is temporarily unavailable`,
  });
}
