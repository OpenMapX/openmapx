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
  wrap<T>(data: T): MobilityResult<T>;
  /** Tag a result with manifest attribution and a realtime freshness stamp. */
  wrapRT<T>(data: T): MobilityResult<T>;
  /**
   * Populate the attribution store from the integration manifest. Call once at
   * the top of `setup(ctx)`; equivalent to the repeated
   * `attribution.set(ctx.manifest.dataSources ?? [])`.
   */
  init(ctx: IntegrationContext): void;
}

export function defineTransitProvider(): TransitProviderScaffold {
  const attribution = createManifestAttribution();
  const wrap = <T>(data: T): MobilityResult<T> =>
    withAttribution(data, attribution.all(), freshnessNow());
  const wrapRT = <T>(data: T): MobilityResult<T> =>
    withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

  return {
    attribution,
    wrap,
    wrapRT,
    init(ctx: IntegrationContext): void {
      ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
    },
  };
}
