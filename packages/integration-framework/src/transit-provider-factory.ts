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
 * Shared scaffolding for transit integrations. Owns ONLY the genuinely
 * identical boilerplate that every `integrations/transit-*` index repeats:
 * the `createManifestAttribution()` store, the `wrap`/`wrapRT` result builders,
 * and the `attribution.set(ctx.manifest.dataSources ?? [])` call.
 *
 * Everything that genuinely diverges between providers stays explicit in each
 * integration's `setup`: the `id`/`prefix`/`coverage`/`priority`, the
 * `capabilities` object, the API-key (or other config) setter, and the method
 * delegations.
 *
 * Typical wiring:
 *   const { attribution, wrap, wrapRT, init } = defineTransitProvider();
 *
 *   export function setup(ctx: IntegrationContext): void {
 *     init(ctx);
 *     provider.setApiKey(ctx.config.apiKey as string | undefined);
 *     ctx.registerTransitProvider({
 *       id: "...",
 *       attribution: attribution.all(),
 *       capabilities: { ... },
 *       async getStop(id) { return wrap(await provider.getStop(id)); },
 *     });
 *   }
 */
export interface TransitProviderScaffold {
  /** Manifest-driven attribution store, shared with the provider registration. */
  readonly attribution: ManifestAttributionStore;
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
  /**
   * Populate the attribution store from the integration manifest. Call once at
   * the top of `setup(ctx)`; equivalent to the repeated
   * `attribution.set(ctx.manifest.dataSources ?? [])`.
   */
  init(ctx: IntegrationContext): void;
}

export function defineTransitProvider(): TransitProviderScaffold {
  const attribution = createManifestAttribution();
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
    attribution,
    wrap,
    wrapRT,
    init(ctx: IntegrationContext): void {
      ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
    },
  };
}
