import type {
  IntegrationContext,
  RideProvider,
  RideQuoteRequest,
} from "@openmapx/integration-framework";
import type { ResolvedRideProvider, RideProviderListing, RideQuoteResult } from "./types.js";

const DEFAULT_QUOTE_TTL_SECONDS = 60;

/**
 * Thrown when a caller asks for several providers' quotes at once while the
 * operator has not unlocked comparison. Carries a 400 rather than a 500 —
 * it is a request-shape error, not a provider outage.
 */
export class RideComparisonError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RideComparisonError";
  }
}

function withinBbox(bbox: [number, number, number, number], [lng, lat]: [number, number]): boolean {
  const [west, south, east, north] = bbox;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function coversPickup(provider: RideProvider, pickup: [number, number]): boolean {
  const bbox = provider.coverage?.bbox;
  if (!bbox) return true;
  return withinBbox(bbox, pickup);
}

export function createRideOrchestrator(ctx: IntegrationContext) {
  const comparisonUnlocked = ctx.config.allowQuoteComparison === true;

  function collectProviders(): ResolvedRideProvider[] {
    const resolved: ResolvedRideProvider[] = [];
    for (const integration of ctx.getIntegrationsByDomain("ride-hailing")) {
      const registered = (integration.providers.get("ride-hailing") ?? []) as RideProvider[];
      for (const provider of registered) {
        resolved.push({ provider, integrationId: integration.id });
      }
    }
    return resolved;
  }

  async function policyAllowed(entries: ResolvedRideProvider[]): Promise<ResolvedRideProvider[]> {
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    if (disallowed.size === 0) return entries;
    return entries.filter((e) => !disallowed.has(e.provider.meta.sourceId));
  }

  async function healthy(entries: ResolvedRideProvider[]): Promise<ResolvedRideProvider[]> {
    if (!ctx.providerHealth) return entries;
    const checks = await Promise.all(
      entries.map(async (e) => ((await ctx.providerHealth?.isHealthy(e.provider.id)) ? e : null)),
    );
    return checks.filter((e): e is ResolvedRideProvider => e !== null);
  }

  /**
   * Wrap a provider call so a single failure never fails the whole request and
   * always lands in the health tracker. Coordinates are never logged — only the
   * provider id, latency and a reason string.
   */
  async function call<T>(
    provider: RideProvider,
    method: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const start = Date.now();
    try {
      const value = await fn();
      const latency = Date.now() - start;
      await ctx.providerHealth?.recordSuccess(provider.id, latency);
      ctx.metricsRecorder?.recordProviderCall(
        { providerId: provider.id, method, outcome: "ok" },
        latency,
      );
      return value;
    } catch (err) {
      const latency = Date.now() - start;
      const reason = err instanceof Error ? err.message : String(err);
      // Coordinates never reach the log — only the provider, method and reason.
      ctx.log.warn(`ride provider call failed: ${provider.id}.${method}`, reason);
      await ctx.providerHealth?.recordFailure(provider.id, latency, reason);
      ctx.metricsRecorder?.recordProviderCall(
        { providerId: provider.id, method, outcome: "error" },
        latency,
      );
      return null;
    }
  }

  async function candidates(request: RideQuoteRequest): Promise<ResolvedRideProvider[]> {
    const byCoverage = collectProviders().filter((e) => coversPickup(e.provider, request.pickup));
    return healthy(await policyAllowed(byCoverage));
  }

  async function listProviders(request: RideQuoteRequest): Promise<RideProviderListing> {
    const entries = await candidates(request);
    const configuredDefault =
      typeof ctx.config.defaultProvider === "string" ? ctx.config.defaultProvider : null;

    const resolved = await Promise.all(
      entries.map(async (e) => {
        const result = await call(e.provider, "getAvailability", () =>
          e.provider.getAvailability(request),
        );
        if (!result?.data.available) return null;
        return {
          id: e.provider.id,
          name: e.provider.meta.name,
          homepage: e.provider.meta.homepage,
          brandColor: e.provider.meta.brandColor,
          capabilities: e.provider.capabilities,
          permitsComparison: e.provider.permitsComparison,
          availability: result.data,
          isDefault: e.provider.id === configuredDefault,
        };
      }),
    );

    const providers = resolved.filter((p): p is NonNullable<typeof p> => p !== null);
    const defaultProvider = providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? null;

    return {
      providers,
      defaultProvider,
      comparison: {
        allowed: comparisonUnlocked,
        // `permitsComparison` encodes the provider's own terms, so it filters
        // the list even when the operator has unlocked comparison.
        comparableProviderIds: comparisonUnlocked
          ? providers.filter((p) => p.permitsComparison).map((p) => p.id)
          : [],
      },
    };
  }

  function getProvider(id: string): RideProvider | null {
    return collectProviders().find((e) => e.provider.id === id)?.provider ?? null;
  }

  async function getQuotes(
    request: RideQuoteRequest,
    providerIds: string[],
  ): Promise<RideQuoteResult[]> {
    if (providerIds.length === 0) {
      throw new RideComparisonError("at least one providerId is required");
    }
    if (providerIds.length > 1 && !comparisonUnlocked) {
      throw new RideComparisonError(
        "quote comparison is disabled by the operator; request one providerId at a time",
      );
    }

    const entries = (await candidates(request)).filter((e) => providerIds.includes(e.provider.id));
    const eligible =
      providerIds.length > 1 ? entries.filter((e) => e.provider.permitsComparison) : entries;

    const now = Date.now();
    return Promise.all(
      eligible.map(async (e) => {
        const getQuotesFn = e.provider.getQuotes;
        if (!e.provider.capabilities.quote || !getQuotesFn) {
          return { providerId: e.provider.id, quotes: [], attributions: e.provider.attribution };
        }
        const result = await call(e.provider, "getQuotes", () => getQuotesFn(request));
        if (!result) {
          return { providerId: e.provider.id, quotes: [], attributions: e.provider.attribution };
        }
        // The orchestrator owns quote lifetime so a provider cannot leave a
        // stale price on screen by returning a distant expiry.
        const ttl = (e.provider.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS) * 1000;
        const expiresAt = new Date(now + ttl).toISOString();
        return {
          providerId: e.provider.id,
          quotes: result.data.map((q) => ({ ...q, expiresAt })),
          attributions: result.attributions.length ? result.attributions : e.provider.attribution,
        };
      }),
    );
  }

  return { listProviders, getQuotes, getProvider };
}
