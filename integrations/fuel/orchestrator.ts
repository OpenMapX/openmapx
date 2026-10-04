import type { BBox } from "@openmapx/core";
import type {
  DataSourcePartialReason,
  FuelStation,
  FuelStationProvider,
  FuelStationQuery,
  IntegrationContext,
  Logger,
} from "@openmapx/integration-framework";

/** Domain and provider-map key fuel-station providers register under. */
const DOMAIN = "fuel-stations";

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
        log.debug(`[fuel] provider ${providerId} failed ${operation} again: ${reason}`);
        return;
      }
      failing.set(providerId, reason);
      log.warn(`[fuel] provider ${providerId} failed ${operation}: ${reason}`);
    },
    succeeded(providerId) {
      if (failing.delete(providerId)) log.info(`[fuel] provider ${providerId} recovered`);
    },
  };
}

/** All fuel-station providers registered across enabled integrations, in registration order. */
export function collectFuelStationProviders(ctx: IntegrationContext): FuelStationProvider[] {
  return ctx
    .getIntegrationsByDomain(DOMAIN)
    .flatMap((i) => (i.providers.get(DOMAIN) ?? []) as FuelStationProvider[]);
}

function coversBbox(coverage: FuelStationProvider["coverage"], bbox: BBox): boolean {
  if (!coverage || "all" in coverage) return true;
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = coverage.bbox;
  return !(e < cw || w > ce || n < cs || s > cn);
}

async function disallowedSources(ctx: IntegrationContext): Promise<Set<string>> {
  return (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
}

function allowed(station: FuelStation, disallowed: Set<string>): boolean {
  return disallowed.size === 0 || !station.sources.some((id) => disallowed.has(id));
}

/**
 * Fans the search out to every provider covering `bbox` in parallel,
 * tolerating individual failures (`Promise.allSettled`), and concatenates
 * their stations in registration order. There is no cross-provider dedup:
 * each provider dedups its own. The operator's disallowed sources are pushed
 * into the query and filtered again on each station's `sources`, so a
 * provider that ignores the hint still cannot leak them. `partial` is set when
 * a provider failed (`unavailable`) or reported a partial answer; `area` wins,
 * since a closer view then does load more. Failures go to `outages`.
 */
export async function aggregateFuelStations(
  ctx: IntegrationContext,
  outages: ProviderOutages,
  bbox: BBox,
  query: FuelStationQuery = {},
): Promise<{ stations: FuelStation[]; partial?: DataSourcePartialReason }> {
  const providers = collectFuelStationProviders(ctx).filter((p) => coversBbox(p.coverage, bbox));
  if (providers.length === 0) return { stations: [] };

  const disallowed = await disallowedSources(ctx);
  const excluded = new Set([...(query.excludedSourceIds ?? []), ...disallowed]);
  const providerQuery: FuelStationQuery =
    excluded.size > 0 ? { ...query, excludedSourceIds: [...excluded] } : query;

  const settled = await Promise.allSettled(
    providers.map((p) => p.searchStations(bbox, providerQuery)),
  );

  const stations: FuelStation[] = [];
  const reasons = new Set<DataSourcePartialReason>();
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") {
      outages.succeeded(providers[i].id);
      stations.push(...res.value.stations);
      if (res.value.partial) reasons.add(res.value.partial);
    } else {
      reasons.add("unavailable");
      outages.failed(providers[i].id, "searchStations", res.reason);
    }
  });

  const kept = stations.filter((s) => allowed(s, excluded));
  const partial = reasons.has("area") ? "area" : reasons.has("unavailable") ? "unavailable" : null;
  return partial ? { stations: kept, partial } : { stations: kept };
}

/**
 * The station with this id, from the provider that holds it. Every provider
 * is asked in parallel and the first one in registration order that returns
 * the station answers, so a detail never needs a preceding search. The
 * operator's disallowed sources are pushed into the read as a search pushes
 * them, so a station opens with the sources it was listed with, and filtered
 * again on the station's `sources`. Failures go to `outages`.
 */
export async function findFuelStation(
  ctx: IntegrationContext,
  outages: ProviderOutages,
  id: string,
): Promise<FuelStation | null> {
  const providers = collectFuelStationProviders(ctx);
  if (providers.length === 0) return null;

  const disallowed = await disallowedSources(ctx);
  const query = { excludedSourceIds: [...disallowed] };
  const settled = await Promise.allSettled(providers.map((p) => p.getStation(id, query)));
  let station: FuelStation | null = null;
  for (const [i, res] of settled.entries()) {
    if (res.status === "rejected") {
      outages.failed(providers[i].id, "getStation", res.reason);
      continue;
    }
    outages.succeeded(providers[i].id);
    if (!station && res.value?.id === id) station = res.value;
  }
  if (!station) return null;
  return allowed(station, disallowed) ? station : null;
}
