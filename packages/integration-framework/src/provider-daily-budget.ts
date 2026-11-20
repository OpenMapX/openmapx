import { createLocalQuotaMeter } from "./local-quota-meter";
import type {
  SharedRequestDecision,
  SharedRequestPolicy,
  UpstreamRuntime,
} from "./upstream-runtime";

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

/** The upstream runtime's cross-replica admission, as `ctx.upstreamRuntime` offers it. */
export interface SharedAdmission {
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
export function dailyRequestLimit(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  const raw = Number(env[name]?.trim());
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/** The shared admission of an integration's upstream runtime, when its host has a store. */
export function sharedAdmissionOf(runtime: UpstreamRuntime | undefined): SharedAdmission | null {
  const admit = runtime?.admitSharedRequest;
  return admit ? { admitSharedRequest: (input) => admit.call(runtime, input) } : null;
}

/**
 * The one daily budget of the deployment's MapTiler key. The tile proxy and
 * MapTiler geocoding both spend it. MapTiler can serve the whole basemap
 * (tiles, glyphs, sprites, satellite and terrain), so a global cap stops the
 * map for everyone; it is therefore off unless the operator sets
 * `MAPTILER_DAILY_REQUEST_LIMIT`. A configured budget keeps working while the
 * store is unreachable by counting in process.
 */
export function maptilerDailyBudget(
  admission: SharedAdmission | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderDailyBudget | null {
  const limit = dailyRequestLimit("MAPTILER_DAILY_REQUEST_LIMIT", env);
  if (limit === undefined) return null;
  return createProviderDailyBudget({
    provider: "maptiler",
    limit,
    admission,
    whenStoreUnavailable: "meter-locally",
  });
}
