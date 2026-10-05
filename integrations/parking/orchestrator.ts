import type { BBox } from "@openmapx/core";
import type {
  DataSourcePartialReason,
  IntegrationContext,
  Logger,
  ParkingSite,
  ParkingSiteProvider,
  ParkingSiteQuery,
} from "@openmapx/integration-framework";

/** Domain and provider-map key parking-site providers register under. */
const DOMAIN = "parking-sites";

/** Records each provider's failures, so an outage is logged when it starts and when it ends. */
export interface ProviderOutages {
  failed(providerId: string, operation: string, err: unknown): void;
  succeeded(providerId: string): void;
}

/**
 * Logs a provider's failures once per outage: a warning when it starts
 * failing or fails for a new reason, a debug line while it keeps failing for
 * the same one, and one line when it answers again. A wrong token or an
 * outage would otherwise warn at every search.
 */
export function createProviderOutages(log: Logger): ProviderOutages {
  const failing = new Map<string, string>();
  return {
    failed(providerId, operation, err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (failing.get(providerId) === reason) {
        log.debug(`[parking] provider ${providerId} failed ${operation} again: ${reason}`);
        return;
      }
      failing.set(providerId, reason);
      log.warn(`[parking] provider ${providerId} failed ${operation}: ${reason}`);
    },
    succeeded(providerId) {
      if (failing.delete(providerId)) log.info(`[parking] provider ${providerId} recovered`);
    },
  };
}

/** All parking-site providers registered across enabled integrations, in registration order. */
export function collectParkingSiteProviders(ctx: IntegrationContext): ParkingSiteProvider[] {
  return ctx
    .getIntegrationsByDomain(DOMAIN)
    .flatMap((i) => (i.providers.get(DOMAIN) ?? []) as ParkingSiteProvider[]);
}

function coversBbox(coverage: ParkingSiteProvider["coverage"], bbox: BBox): boolean {
  if (!coverage || "all" in coverage) return true;
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = coverage.bbox;
  return !(e < cw || w > ce || n < cs || s > cn);
}

async function disallowedSources(ctx: IntegrationContext): Promise<Set<string>> {
  return (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
}

/** A site built from several records lists every member's source, so one disallowed member drops it. */
function allowed(site: ParkingSite, disallowed: Set<string>): boolean {
  return disallowed.size === 0 || !site.sources.some((id) => disallowed.has(id));
}

/**
 * Fans the search out to every provider covering `bbox` in parallel,
 * tolerating individual failures (`Promise.allSettled`), and concatenates
 * their sites in registration order. There is no cross-provider dedup: each
 * provider dedups its own. The operator's disallowed sources are pushed into
 * the query and filtered again on each site's `sources`, so a provider that
 * ignores the hint still cannot leak them. `partial` is set when a provider
 * failed (`unavailable`) or reported a partial answer; `area` wins, since a
 * closer view then does load more. Failures go to `outages`.
 */
export async function aggregateParkingSites(
  ctx: IntegrationContext,
  outages: ProviderOutages,
  bbox: BBox,
  query: ParkingSiteQuery = {},
): Promise<{ sites: ParkingSite[]; partial?: DataSourcePartialReason }> {
  const providers = collectParkingSiteProviders(ctx).filter((p) => coversBbox(p.coverage, bbox));
  if (providers.length === 0) return { sites: [] };

  const disallowed = await disallowedSources(ctx);
  const excluded = new Set([...(query.excludedSourceIds ?? []), ...disallowed]);
  const providerQuery: ParkingSiteQuery =
    excluded.size > 0 ? { ...query, excludedSourceIds: [...excluded] } : query;

  const settled = await Promise.allSettled(
    providers.map((p) => p.searchSites(bbox, providerQuery)),
  );

  const sites: ParkingSite[] = [];
  const reasons = new Set<DataSourcePartialReason>();
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") {
      outages.succeeded(providers[i].id);
      sites.push(...res.value.sites);
      if (res.value.partial) reasons.add(res.value.partial);
    } else {
      reasons.add("unavailable");
      outages.failed(providers[i].id, "searchSites", res.reason);
    }
  });

  const kept = sites.filter((s) => allowed(s, excluded));
  const partial = reasons.has("area") ? "area" : reasons.has("unavailable") ? "unavailable" : null;
  return partial ? { sites: kept, partial } : { sites: kept };
}

/**
 * The site with this id, from the provider that holds it. Every provider is
 * asked in parallel and the first one in registration order that returns the
 * site answers, so a detail never needs a preceding search. The operator's
 * disallowed sources are pushed into the read as a search pushes them, so a
 * site opens with the sources it was listed with, and filtered again on the
 * site's `sources`. Failures go to `outages`.
 */
export async function findParkingSite(
  ctx: IntegrationContext,
  outages: ProviderOutages,
  id: string,
): Promise<ParkingSite | null> {
  const providers = collectParkingSiteProviders(ctx);
  if (providers.length === 0) return null;

  const disallowed = await disallowedSources(ctx);
  const query = { excludedSourceIds: [...disallowed] };
  const settled = await Promise.allSettled(providers.map((p) => p.getSite(id, query)));
  let site: ParkingSite | null = null;
  for (const [i, res] of settled.entries()) {
    if (res.status === "rejected") {
      outages.failed(providers[i].id, "getSite", res.reason);
      continue;
    }
    outages.succeeded(providers[i].id);
    if (!site && res.value?.id === id) site = res.value;
  }
  if (!site) return null;
  return allowed(site, disallowed) ? site : null;
}
