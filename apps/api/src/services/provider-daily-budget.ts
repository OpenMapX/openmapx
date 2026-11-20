import {
  maptilerDailyBudget as createMaptilerDailyBudget,
  createProviderDailyBudget,
  dailyRequestLimit,
  type ProviderBudgetDecision,
  type ProviderDailyBudget,
  type SharedAdmission,
} from "@openmapx/integration-framework/provider-daily-budget";
import { redis } from "../redis.js";
import type { UpstreamRedisClient } from "./upstream-runtime/index.js";
import { createSharedAdmission } from "./upstream-runtime/shared-admission.js";

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
    limit: dailyRequestLimit("TOMTOM_TRAFFIC_DAILY_REQUEST_LIMIT") ?? 50_000,
    admission: configuredSharedAdmission(),
    whenStoreUnavailable: "refuse",
  });
}

/** The MapTiler key's daily budget, shared with MapTiler geocoding; null when unset. */
export function maptilerDailyBudget(): ProviderDailyBudget | null {
  return createMaptilerDailyBudget(configuredSharedAdmission());
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
    error:
      decision.status === 429
        ? `${provider} has used its daily request budget`
        : `${provider} is temporarily unavailable`,
  });
}
