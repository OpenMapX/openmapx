import {
  createLocalQuotaMeter,
  type IntegrationContext,
  type QuotaDecision,
} from "@openmapx/integration-framework";
import type { RoutingProvider } from "./types.js";

const DEFAULT_REQUESTS_PER_MINUTE = 3_000;
const DEFAULT_REQUESTS_PER_DAY = 500_000;

/**
 * A routing engine call the provider budget refused. The engine was not
 * contacted.
 */
class RoutingAdmissionDeniedError extends Error {
  readonly status = 429;

  constructor(readonly retryAfterSeconds: number) {
    super("Routing is temporarily over its request budget");
    this.name = "RoutingAdmissionDeniedError";
  }
}

/**
 * The error a chain of engine attempts should report. A refusal by the
 * budget says nothing about the route, so once any engine has failed
 * upstream that failure wins: a preferred engine's 5xx followed by a
 * fallback engine's refusal answers 502, not 429.
 */
export function routingChainError(previous: unknown, next: unknown): unknown {
  if (previous !== undefined && next instanceof RoutingAdmissionDeniedError) return previous;
  return next;
}

/** Answers a denied engine call; returns false for any other error. */
export function sendRoutingAdmissionDenied(
  reply: {
    header: (name: string, value: string) => void;
    status: (code: number) => { send: (data: unknown) => void };
  },
  error: unknown,
): boolean {
  if (!(error instanceof RoutingAdmissionDeniedError)) return false;
  reply.header("Retry-After", String(error.retryAfterSeconds));
  reply.header("Cache-Control", "no-store");
  reply.status(error.status).send({ error: error.message });
  return true;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

type Admit = () => Promise<void>;

/**
 * Global admission for routing engines. Every engine call (route, optimize,
 * map match, matrix) first takes one unit from a per-engine budget shared by
 * all clients and API replicas, so the per-client limits cannot be multiplied
 * by rotating addresses into unbounded load on a local engine or spend on a
 * metered one.
 *
 * With no shared store configured (a development checkout) calls are not
 * metered. With a store configured but unreachable, the same budget is
 * counted in this process instead, so routing keeps working and the engine
 * stays metered (each replica then admits up to the full budget).
 */
export function createRoutingProviderAdmission(ctx: IntegrationContext) {
  const runtime = ctx.upstreamRuntime;
  const localMeter = createLocalQuotaMeter();
  const perMinute = positiveInteger(
    ctx.config?.providerRequestsPerMinute,
    DEFAULT_REQUESTS_PER_MINUTE,
  );
  const perDay = positiveInteger(ctx.config?.providerRequestsPerDay, DEFAULT_REQUESTS_PER_DAY);

  const admitFor =
    (integrationId: string): Admit =>
    async () => {
      if (!runtime) return;
      const request = {
        bucket: `routing-provider:${integrationId}`,
        cost: 1,
        windows: [
          { id: "minute", limit: perMinute, durationMs: 60_000 },
          { id: "day", limit: perDay, durationMs: 86_400_000 },
        ],
      };
      let decision: QuotaDecision = await runtime.consumeQuota(request);
      if (decision.diagnostic === "store_unavailable") decision = localMeter.consume(request);
      if (decision.allowed) return;
      const retryAfterMs = decision.retryAt === null ? 60_000 : decision.retryAt - Date.now();
      throw new RoutingAdmissionDeniedError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    };

  /**
   * The same provider with every engine call admitted first. The original
   * object stays the prototype, so capability flags and any other members
   * read through unchanged.
   */
  function admitted(provider: RoutingProvider, integrationId: string): RoutingProvider {
    if (!runtime) return provider;
    const admit = admitFor(integrationId);
    const wrapped = Object.create(provider) as {
      -readonly [K in keyof RoutingProvider]: RoutingProvider[K];
    };
    wrapped.getRoute = async (...args) => {
      await admit();
      return provider.getRoute(...args);
    };
    const { optimizeRoute, getMatch, getMatrix, getIsochrone } = provider;
    if (optimizeRoute) {
      wrapped.optimizeRoute = async (...args) => {
        await admit();
        return optimizeRoute.apply(provider, args);
      };
    }
    if (getMatch) {
      wrapped.getMatch = async (...args) => {
        await admit();
        return getMatch.apply(provider, args);
      };
    }
    if (getMatrix) {
      wrapped.getMatrix = async (...args) => {
        await admit();
        return getMatrix.apply(provider, args);
      };
    }
    if (getIsochrone) {
      wrapped.getIsochrone = async (...args) => {
        await admit();
        return getIsochrone.apply(provider, args);
      };
    }
    return wrapped;
  }

  return { admitted };
}
