import type { IntegrationDataSource } from "@openmapx/extension-contracts/integration";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { dataSourceToAttribution } from "@openmapx/mobility-core/contributors";

export * from "@openmapx/extension-contracts/integration";

/**
 * Convert an integration-manifest data source descriptor into the canonical
 * `Attribution` shape used by `MobilityResult.attributions` and the map
 * attribution control. Providers should call this on the manifest entries
 * passed through their `setup(ctx)` rather than hand-rolling their own
 * Attribution objects, so all credit metadata lives in one place — the
 * manifest.
 */
export { dataSourceToAttribution };

/**
 * Manifest-driven attribution store. Integrations populate it once at
 * `setup(ctx)` from `ctx.manifest.dataSources` and read from it for both
 * provider-level `attribution` and per-response credits. Removes the need
 * for hand-rolled `const ATTRIBUTION: Attribution[] = [...]` literals that
 * duplicated manifest metadata in code.
 *
 * Typical wiring:
 *
 * ```ts
 * const attribution = createManifestAttribution();
 *
 * export function setup(ctx: IntegrationContext) {
 *   attribution.set(ctx.manifest.dataSources ?? []);
 *   ctx.registerMobilityDataSource(provider);
 * }
 *
 * class Provider {
 *   get attribution() { return attribution.all(); }
 *   async search(...) {
 *     return withAttribution(results, attribution.forResults(results), ...);
 *   }
 * }
 * ```
 */
export interface ManifestAttributionStore {
  /** Populate the store from a manifest's `dataSources` list. */
  set(dataSources: IntegrationDataSource[]): void;
  /** All attributions, in manifest order. */
  all(): Attribution[];
  /** Look up a single attribution by `sourceId`. */
  bySource(sourceId: string): Attribution | undefined;
  /**
   * Build the attribution list for a response, crediting only the sources
   * that actually contributed. By default reads `result.source`; pass a
   * `sourcesFor` extractor to return multiple sources per result (e.g.
   * deduped records that merged data from several providers, where
   * `result.sources: string[]` is the authoritative list).
   */
  forResults<T>(
    results: T[],
    sourcesFor?: (result: T) => string | string[] | undefined,
  ): Attribution[];
}

export function createManifestAttribution(): ManifestAttributionStore {
  const map: Record<string, Attribution> = {};
  const all: Attribution[] = [];

  return {
    set(dataSources) {
      const nextMap: Record<string, Attribution> = {};
      const nextAll: Attribution[] = [];
      for (const ds of dataSources) {
        const attr = dataSourceToAttribution(ds);
        nextMap[attr.sourceId] = attr;
        nextAll.push(attr);
      }
      for (const key of Object.keys(map)) delete map[key];
      Object.assign(map, nextMap);
      all.splice(0, all.length, ...nextAll);
    },
    all() {
      return all;
    },
    bySource(sourceId) {
      return map[sourceId];
    },
    forResults(results, sourcesFor) {
      const seen = new Set<string>();
      const out: Attribution[] = [];
      for (const r of results) {
        const raw = sourcesFor ? sourcesFor(r) : (r as { source?: string }).source;
        const keys = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const key of keys) {
          if (seen.has(key)) continue;
          seen.add(key);
          const attr = map[key];
          if (attr) out.push(attr);
        }
      }
      return out;
    },
  };
}
