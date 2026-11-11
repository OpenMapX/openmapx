import {
  captureTransitContributors,
  transitDataContributors,
} from "@openmapx/mobility-core/transit-contributors";

export { captureTransitContributors } from "@openmapx/mobility-core/transit-contributors";

import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import type { IntegrationContext } from "./context";
import { createManifestAttribution, type ManifestAttributionStore } from "./manifest";

/**
 * Shared scaffolding for transit integrations: the manifest attribution store
 * and the `wrap`/`wrapRT` result builders.
 *
 * Create the scaffold inside `setup(ctx)`. Each setup generation then owns its
 * attribution, built from that generation's manifest, so a request that started
 * before a reload keeps crediting the sources of the generation that served it.
 *
 * Everything that genuinely diverges between providers stays explicit in each
 * integration's `setup`: the `id`/`prefix`/`coverage`/`priority`, the
 * `capabilities` object, the API-key (or other config) setter, and the method
 * delegations.
 *
 * Typical wiring:
 *   export function setup(ctx: IntegrationContext): void {
 *     const { attribution, wrap, wrapRT } = defineTransitProvider(ctx);
 *     ctx.registerTransitProvider({
 *       id: "...",
 *       attribution: attribution.all(),
 *       capabilities: { ... },
 *       async getStop(id) { return wrap(await provider.getStop(id)); },
 *     });
 *   }
 */
export interface TransitProviderScaffold {
  /** This generation's manifest attribution, shared with the provider registration. */
  readonly attribution: Pick<ManifestAttributionStore, "all" | "bySource" | "forResults">;
  /** Tag a result with manifest attribution and a non-realtime freshness stamp. */
  wrap<T>(data: T, sourceIds?: readonly string[]): MobilityResult<T>;
  /**
   * Tag a result with manifest attribution and a realtime freshness stamp.
   * `dataAsOf` is when the upstream last updated the realtime data, when it says.
   */
  wrapRT<T>(
    data: T,
    sourceIds?: readonly string[],
    options?: { dataAsOf?: string },
  ): MobilityResult<T>;
}

export function defineTransitProvider(ctx: IntegrationContext): TransitProviderScaffold {
  const attribution = createManifestAttribution();
  attribution.set(ctx.manifest.dataSources ?? []);
  const selected = (sourceIds?: readonly string[]) =>
    sourceIds === undefined
      ? attribution.all()
      : sourceIds.flatMap((id) => attribution.bySource(id) ?? []);
  const wrap = <T>(data: T, sourceIds?: readonly string[]): MobilityResult<T> => {
    const receipts = selected(sourceIds);
    const captured = captureTransitContributors(data, receipts);
    return withAttribution(captured, transitDataContributors(captured), freshnessNow());
  };
  const wrapRT = <T>(
    data: T,
    sourceIds?: readonly string[],
    options?: { dataAsOf?: string },
  ): MobilityResult<T> => {
    const receipts = selected(sourceIds);
    const captured = captureTransitContributors(data, receipts);
    return withAttribution(captured, transitDataContributors(captured), {
      ...freshnessNow({ hasRealtimeData: true }),
      ...(options?.dataAsOf ? { dataAsOf: options.dataAsOf } : {}),
    });
  };

  return {
    attribution: {
      all: () => attribution.all(),
      bySource: (sourceId) => attribution.bySource(sourceId),
      forResults: (results, sourcesFor) => attribution.forResults(results, sourcesFor),
    },
    wrap,
    wrapRT,
  };
}
