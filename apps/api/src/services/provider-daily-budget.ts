import type { SharedRequestDecision, SharedRequestPolicy } from "@openmapx/integration-framework";
import { redis } from "../redis.js";
import type { UpstreamRedisClient } from "./upstream-runtime/index.js";
import { createSharedAdmission } from "./upstream-runtime/shared-admission.js";

const DAY_MS = 86_400_000;
const STORE_UNAVAILABLE_RETRY_SECONDS = 30;

export type ProviderBudgetDecision =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; retryAfterSeconds: number };

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
 * metered. With a store configured but unreachable the request is refused
 * with 503: the budget cannot be checked, and a store failure must not turn
 * into unmetered use of a paid key.
 */
export function createProviderDailyBudget(options: {
  provider: string;
  limit: number;
  admission: SharedAdmission | null;
}): ProviderDailyBudget {
  const policy: SharedRequestPolicy = {
    id: "daily",
    limit: options.limit,
    durationMs: DAY_MS,
    minIntervalMs: 0,
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
      if (decision.reason === "store_unavailable") {
        return { allowed: false, status: 503, retryAfterSeconds: STORE_UNAVAILABLE_RETRY_SECONDS };
      }
      const retryAfterMs = decision.retryAfterMs ?? 60_000;
      return {
        allowed: false,
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    },
  };
}

function dailyLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name]?.trim());
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
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

/** TomTom's free tier allows 50,000 tile requests a day. */
export function tomtomTrafficDailyBudget(): ProviderDailyBudget {
  return createProviderDailyBudget({
    provider: "tomtom-traffic",
    limit: dailyLimit("TOMTOM_TRAFFIC_DAILY_REQUEST_LIMIT", 50_000),
    admission: configuredSharedAdmission(),
  });
}

/** MapTiler's free tier allows about 100,000 requests a month, about 3,300 a day. */
export function maptilerDailyBudget(): ProviderDailyBudget {
  return createProviderDailyBudget({
    provider: "maptiler",
    limit: dailyLimit("MAPTILER_DAILY_REQUEST_LIMIT", 3_300),
    admission: configuredSharedAdmission(),
  });
}

/** The 429 or 503 a refused provider request answers with. */
export function sendProviderBudgetRefusal(
  reply: {
    header(name: string, value: string): unknown;
    status(code: number): { send(payload: unknown): unknown };
  },
  decision: Exclude<ProviderBudgetDecision, { allowed: true }>,
  provider: string,
) {
  reply.header("Cache-Control", "no-store");
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  return reply.status(decision.status).send({
    message:
      decision.status === 429
        ? `${provider} has used its daily request budget`
        : `${provider} is temporarily unavailable`,
  });
}
