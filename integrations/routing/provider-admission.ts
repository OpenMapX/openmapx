import type { IntegrationContext } from "@openmapx/integration-framework";
import type { RoutingProvider } from "./types.js";

const DEFAULT_REQUESTS_PER_MINUTE = 600;
const DEFAULT_REQUESTS_PER_DAY = 100_000;
const STORE_UNAVAILABLE_RETRY_SECONDS = 30;

/**
 * A routing engine call the shared provider budget refused. The engine was not
 * contacted. `status` is 429 when the budget is spent and 503 when the shared
 * store could not be asked.
 */
export class RoutingAdmissionDeniedError extends Error {
  readonly status: 429 | 503;

  constructor(
    readonly reason: "quota" | "store_unavailable",
    readonly retryAfterSeconds: number,
  ) {
    super(
      reason === "quota"
        ? "Routing is temporarily over its request budget"
        : "Routing admission is temporarily unavailable",
    );
    this.name = "RoutingAdmissionDeniedError";
    this.status = reason === "quota" ? 429 : 503;
  }
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
 * metered. With a store configured but unreachable, calls are refused: the
 * budget cannot be checked, and the upstream runtime contract never lets a
 * store failure turn into unmetered upstream use.
 */
export function createRoutingProviderAdmission(ctx: IntegrationContext) {
  const runtime = ctx.upstreamRuntime;
  const perMinute = positiveInteger(
    ctx.config?.providerRequestsPerMinute,
    DEFAULT_REQUESTS_PER_MINUTE,
  );
  const perDay = positiveInteger(ctx.config?.providerRequestsPerDay, DEFAULT_REQUESTS_PER_DAY);

  const admitFor =
    (integrationId: string): Admit =>
    async () => {
      if (!runtime) return;
      const decision = await runtime.consumeQuota({
        bucket: `routing-provider:${integrationId}`,
        cost: 1,
        windows: [
          { id: "minute", limit: perMinute, durationMs: 60_000 },
          { id: "day", limit: perDay, durationMs: 86_400_000 },
        ],
      });
      if (decision.allowed) return;
      if (decision.diagnostic === "store_unavailable") {
        throw new RoutingAdmissionDeniedError("store_unavailable", STORE_UNAVAILABLE_RETRY_SECONDS);
      }
      const retryAfterMs = decision.retryAt === null ? 60_000 : decision.retryAt - Date.now();
      throw new RoutingAdmissionDeniedError("quota", Math.max(1, Math.ceil(retryAfterMs / 1000)));
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
