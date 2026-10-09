import {
  type BBox,
  type BoundingBox,
  type DataSourcePartialReason,
  isSafeHttpUrl,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import {
  allowedSources,
  type CollectionProvider,
  type CollectionQuery,
  createCollectionOrchestrator,
  createProviderOutages,
} from "./collection-orchestrator";
import type { IntegrationContext } from "./context";

type SiteProvider = CollectionProvider;

/** What every site has: an id and the sources it was built from. */
interface Site {
  id: string;
  sources: readonly string[];
}

type SiteQuery = CollectionQuery;

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
  const collection = createCollectionOrchestrator<TProvider, TSite, TQuery>(ctx, {
    domain: options.domain,
    logPrefix: options.logPrefix,
    name: options.search.name,
    outages,
    run: async (provider, bbox, query) => {
      const { sites, partial } = await options.search.run(provider, bbox, query);
      return partial ? { items: sites, partial } : { items: sites };
    },
    sourcesOf: (site) => site.sources,
  });
  const providers = collection.providers;

  return {
    providers,

    async search(bbox, query) {
      const { items, partial } = await collection.read(bbox, query);
      return partial ? { sites: items, partial } : { sites: items };
    },

    async find(id) {
      const all = providers();
      if (all.length === 0) return null;

      const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
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
      return allowedSources(site.sources, disallowed) ? site : null;
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
