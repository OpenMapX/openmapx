import type { BBox, DataSourcePartialReason } from "@openmapx/core";
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

/** What every provider of a collection has: an id and, optionally, the area it covers. */
export interface CollectionProvider {
  readonly id: string;
  readonly coverage?: { bbox: BBox } | { all: true };
}

export interface CollectionQuery {
  excludedSourceIds?: readonly string[];
}

export interface CollectionOrchestratorOptions<TProvider, TItem, TQuery> {
  /** Domain and provider-map key the providers register under. */
  domain: string;
  /** Prefix of the outage log lines, e.g. `parking`. */
  logPrefix: string;
  /** The contract's operation name, as the outage log shows it. */
  name: string;
  /**
   * A provider's read. The query is the caller's with the disallowed sources
   * added, or only those when the caller passed none.
   */
  run(
    provider: TProvider,
    bbox: BBox,
    query: TQuery | CollectionQuery,
  ): Promise<{ items: TItem[]; partial?: DataSourcePartialReason }>;
  /** The sources an item was built from; one disallowed source drops it. */
  sourcesOf(item: TItem): readonly string[];
  /** Outage state shared with the caller's other operations; a fresh one by default. */
  outages?: ProviderOutages;
}

export interface CollectionOrchestrator<TProvider, TItem, TQuery> {
  /** Every provider registered across enabled integrations, in registration order. */
  providers(): TProvider[];
  /**
   * Fans the read out to every provider covering `bbox` in parallel,
   * tolerating individual failures, and concatenates their items in
   * registration order. There is no cross-provider dedup: each provider
   * dedups its own. The operator's disallowed sources are pushed into the
   * query and filtered again on each item's sources, so a provider that
   * ignores the hint still cannot leak them. `partial` is set when a provider
   * failed (`unavailable`) or reported a partial answer; `area` wins, since a
   * closer view then does load more.
   */
  read(bbox: BBox, query?: TQuery): Promise<{ items: TItem[]; partial?: DataSourcePartialReason }>;
}

export function coversBbox(coverage: CollectionProvider["coverage"], bbox: BBox): boolean {
  if (!coverage || "all" in coverage) return true;
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = coverage.bbox;
  return !(e < cw || w > ce || n < cs || s > cn);
}

/** An item built from several records lists every member's source, so one disallowed member drops it. */
export function allowedSources(
  sources: readonly string[],
  disallowed: ReadonlySet<string>,
): boolean {
  return disallowed.size === 0 || !sources.some((id) => disallowed.has(id));
}

/**
 * One whole-area read over every provider of a domain: coverage, the
 * operator's disallowed sources pushed and re-filtered, tolerated failures
 * logged once per outage, and the merged `partial` reason.
 */
export function createCollectionOrchestrator<
  TProvider extends CollectionProvider,
  TItem,
  TQuery extends CollectionQuery,
>(
  ctx: IntegrationContext,
  options: CollectionOrchestratorOptions<TProvider, TItem, TQuery>,
): CollectionOrchestrator<TProvider, TItem, TQuery> {
  const outages = options.outages ?? createProviderOutages(ctx.log, options.logPrefix);
  const providers = (): TProvider[] =>
    ctx
      .getIntegrationsByDomain(options.domain)
      .flatMap((i) => (i.providers.get(options.domain) ?? []) as TProvider[]);

  return {
    providers,

    async read(bbox, query) {
      const covering = providers().filter((p) => coversBbox(p.coverage, bbox));
      if (covering.length === 0) return { items: [] };

      const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
      const excluded = new Set([...(query?.excludedSourceIds ?? []), ...disallowed]);
      const providerQuery: TQuery | CollectionQuery =
        excluded.size > 0 ? { ...query, excludedSourceIds: [...excluded] } : (query ?? {});

      const settled = await Promise.allSettled(
        covering.map((p) => options.run(p, bbox, providerQuery)),
      );

      const items: TItem[] = [];
      const reasons = new Set<DataSourcePartialReason>();
      settled.forEach((res, i) => {
        if (res.status === "fulfilled") {
          outages.succeeded(covering[i].id);
          items.push(...res.value.items);
          if (res.value.partial) reasons.add(res.value.partial);
        } else {
          reasons.add("unavailable");
          outages.failed(covering[i].id, options.name, res.reason);
        }
      });

      const kept = items.filter((item) => allowedSources(options.sourcesOf(item), excluded));
      const partial = reasons.has("area")
        ? "area"
        : reasons.has("unavailable")
          ? "unavailable"
          : null;
      return partial ? { items: kept, partial } : { items: kept };
    },
  };
}
