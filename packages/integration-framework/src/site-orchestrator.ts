import {
  type BBox,
  type BoundingBox,
  type DataSourcePartialReason,
  isSafeHttpUrl,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import type { IntegrationContext, Logger } from "./context";

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
export function createProviderOutages(log: Logger, logPrefix: string): ProviderOutages {
  const failing = new Map<string, string>();
  return {
    failed(providerId, operation, err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (failing.get(providerId) === reason) {
        log.debug(`[${logPrefix}] provider ${providerId} failed ${operation} again: ${reason}`);
        return;
      }
      failing.set(providerId, reason);
      log.warn(`[${logPrefix}] provider ${providerId} failed ${operation}: ${reason}`);
    },
    succeeded(providerId) {
      if (failing.delete(providerId)) log.info(`[${logPrefix}] provider ${providerId} recovered`);
    },
  };
}

/** What every site provider has: an id and, optionally, the area it covers. */
interface SiteProvider {
  readonly id: string;
  readonly coverage?: { bbox: BBox } | { all: true };
}

/** What every site has: an id and the sources it was built from. */
interface Site {
  id: string;
  sources: readonly string[];
}

interface SiteQuery {
  excludedSourceIds?: readonly string[];
}

export interface SiteOrchestratorOptions<TProvider, TSite, TQuery> {
  /** Domain and provider-map key the providers register under. */
  domain: string;
  /** Prefix of the outage log lines, e.g. `parking`. */
  logPrefix: string;
  /**
   * A provider's search, under the contract's operation name. The query is
   * the caller's with the disallowed sources added, or only those when the
   * caller passed none.
   */
  search: {
    name: string;
    run(
      provider: TProvider,
      bbox: BBox,
      query: TQuery | SiteQuery,
    ): Promise<{ sites: TSite[]; partial?: DataSourcePartialReason }>;
  };
  /** A provider's read by id, under the contract's operation name; it takes only the exclusions. */
  get: {
    name: string;
    run(provider: TProvider, id: string, query: SiteQuery): Promise<TSite | null>;
  };
}

export interface SiteOrchestrator<TProvider, TSite, TQuery> {
  /** Every provider registered across enabled integrations, in registration order. */
  providers(): TProvider[];
  /**
   * Fans the search out to every provider covering `bbox` in parallel,
   * tolerating individual failures, and concatenates their sites in
   * registration order. There is no cross-provider dedup: each provider
   * dedups its own. The operator's disallowed sources are pushed into the
   * query and filtered again on each site's `sources`, so a provider that
   * ignores the hint still cannot leak them. `partial` is set when a provider
   * failed (`unavailable`) or reported a partial answer; `area` wins, since a
   * closer view then does load more.
   */
  search(
    bbox: BBox,
    query?: TQuery,
  ): Promise<{ sites: TSite[]; partial?: DataSourcePartialReason }>;
  /**
   * The site with this id, from the provider that holds it. Every provider is
   * asked in parallel and the first one in registration order that returns
   * the site answers, so a detail never needs a preceding search. The
   * disallowed sources are pushed into the read as a search pushes them, so a
   * site opens with the sources it was listed with, and filtered again on the
   * site's `sources`.
   */
  find(id: string): Promise<TSite | null>;
}

function coversBbox(coverage: SiteProvider["coverage"], bbox: BBox): boolean {
  if (!coverage || "all" in coverage) return true;
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = coverage.bbox;
  return !(e < cw || w > ce || n < cs || s > cn);
}

/** A site built from several records lists every member's source, so one disallowed member drops it. */
function allowed(site: Site, disallowed: ReadonlySet<string>): boolean {
  return disallowed.size === 0 || !site.sources.some((id) => disallowed.has(id));
}

/**
 * Merges every provider of one site domain behind one search and one read by
 * id. Provider failures are logged once per outage.
 */
export function createSiteOrchestrator<
  TProvider extends SiteProvider,
  TSite extends Site,
  TQuery extends SiteQuery,
>(
  ctx: IntegrationContext,
  options: SiteOrchestratorOptions<TProvider, TSite, TQuery>,
): SiteOrchestrator<TProvider, TSite, TQuery> {
  const outages = createProviderOutages(ctx.log, options.logPrefix);
  const providers = (): TProvider[] =>
    ctx
      .getIntegrationsByDomain(options.domain)
      .flatMap((i) => (i.providers.get(options.domain) ?? []) as TProvider[]);
  const disallowedSources = async (): Promise<Set<string>> =>
    (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();

  return {
    providers,

    async search(bbox, query) {
      const covering = providers().filter((p) => coversBbox(p.coverage, bbox));
      if (covering.length === 0) return { sites: [] };

      const disallowed = await disallowedSources();
      const excluded = new Set([...(query?.excludedSourceIds ?? []), ...disallowed]);
      const providerQuery: TQuery | SiteQuery =
        excluded.size > 0 ? { ...query, excludedSourceIds: [...excluded] } : (query ?? {});

      const settled = await Promise.allSettled(
        covering.map((p) => options.search.run(p, bbox, providerQuery)),
      );

      const sites: TSite[] = [];
      const reasons = new Set<DataSourcePartialReason>();
      settled.forEach((res, i) => {
        if (res.status === "fulfilled") {
          outages.succeeded(covering[i].id);
          sites.push(...res.value.sites);
          if (res.value.partial) reasons.add(res.value.partial);
        } else {
          reasons.add("unavailable");
          outages.failed(covering[i].id, options.search.name, res.reason);
        }
      });

      const kept = sites.filter((s) => allowed(s, excluded));
      const partial = reasons.has("area")
        ? "area"
        : reasons.has("unavailable")
          ? "unavailable"
          : null;
      return partial ? { sites: kept, partial } : { sites: kept };
    },

    async find(id) {
      const all = providers();
      if (all.length === 0) return null;

      const disallowed = await disallowedSources();
      const query: SiteQuery = { excludedSourceIds: [...disallowed] };
      const settled = await Promise.allSettled(all.map((p) => options.get.run(p, id, query)));
      let site: TSite | null = null;
      for (const [i, res] of settled.entries()) {
        if (res.status === "rejected") {
          outages.failed(all[i].id, options.get.name, res.reason);
          continue;
        }
        outages.succeeded(all[i].id);
        if (!site && res.value?.id === id) site = res.value;
      }
      if (!site) return null;
      return allowed(site, disallowed) ? site : null;
    },
  };
}

/** A credit whose links come from upstream data, keeping only http(s) ones. */
function safeAttribution(attribution: Attribution): Attribution {
  const { url, licenseUrl, publisher, ...rest } = attribution;
  return {
    ...rest,
    ...(isSafeHttpUrl(url) ? { url } : {}),
    ...(isSafeHttpUrl(licenseUrl) ? { licenseUrl } : {}),
    ...(publisher
      ? {
          publisher: {
            name: publisher.name,
            ...(isSafeHttpUrl(publisher.url) ? { url: publisher.url } : {}),
          },
        }
      : {}),
  };
}

/** A data-source answer without realtime data, with its attributions' safe links. */
export const wrapSiteResult = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(
    data,
    attributions.map(safeAttribution),
    freshnessNow({ hasRealtimeData: false }),
  );

/**
 * Every contributing credit, once, in first-seen order: keyed by source and
 * name, so an upstream publisher credited under its feed's source stays.
 * Their links come from upstream data, so only http(s) ones are kept.
 */
export function siteAttributions(sites: readonly { attributions: Attribution[] }[]): Attribution[] {
  const byCredit = new Map<string, Attribution>();
  for (const site of sites) {
    for (const attribution of site.attributions) {
      const key = `${attribution.sourceId}\u0000${attribution.name}`;
      if (!byCredit.has(key)) byCredit.set(key, safeAttribution(attribution));
    }
  }
  return [...byCredit.values()];
}

/** The selected option ids of a multi-select filter; none selected keeps every site. */
export function selectedOptions(
  filters: Record<string, unknown> | undefined,
  id: string,
): Set<string> {
  const raw = filters?.[id];
  if (raw === undefined || raw === null || raw === "") return new Set();
  return new Set((Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean));
}

/** A map's bounding box as a `[west, south, east, north]` tuple. */
export function toBBox(bbox: BoundingBox): BBox {
  return [bbox.west, bbox.south, bbox.east, bbox.north];
}

/** The side of a map tile, in CSS pixels (MapLibre's vector tiles). */
const TILE_PX = 512;
/** The widest map view a search is answered for, in CSS pixels per side. */
const MAX_VIEW_PX = 4096;

/**
 * Whether a box is no wider than a map view of up to `MAX_VIEW_PX` pixels a
 * side shows at `zoom`: a tile spans 360 / 2^zoom degrees of longitude, and
 * the degrees of latitude a pixel spans shrink with the cosine of the latitude.
 * A data source answers a wider box empty, so its providers never fetch a
 * region's sites for a view the map does not ask at.
 */
export function withinZoom(bbox: BoundingBox, zoom: number): boolean {
  const lonSpan = (360 / 2 ** zoom) * (MAX_VIEW_PX / TILE_PX);
  const midLat = (bbox.south + bbox.north) / 2;
  const latSpan = lonSpan * Math.cos((midLat * Math.PI) / 180);
  return bbox.east - bbox.west <= lonSpan && bbox.north - bbox.south <= latSpan;
}
