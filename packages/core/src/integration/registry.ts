import type { LoadedIntegrationMeta } from "./loader";
import type { IntegrationDataSource } from "./manifest";

export class IntegrationRegistry {
  private integrations: LoadedIntegrationMeta[];

  constructor(integrations: LoadedIntegrationMeta[]) {
    this.integrations = integrations;
  }

  getAll(): LoadedIntegrationMeta[] {
    return this.integrations;
  }

  getEnabled(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled);
  }

  getByDomain(domain: string): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.domains.includes(domain));
  }

  get(id: string): LoadedIntegrationMeta | undefined {
    return this.integrations.find((i) => i.id === id);
  }

  /**
   * Resolve a data source by its `sourceId` across all enabled integrations,
   * regardless of which domain registered it. Source IDs are globally unique
   * in the manifest schema, so integrations outside the consuming domain can
   * still supply attribution (e.g. a `knowledge-wikipedia` source rendered in
   * the photo gallery).
   */
  findDataSource(sourceId: string): IntegrationDataSource | undefined {
    for (const integration of this.integrations) {
      if (!integration.enabled) continue;
      const match = integration.dataSources?.find((d) => d.sourceId === sourceId);
      if (match) return match;
    }
    return undefined;
  }

  getWithMapLayer(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.frontend?.mapLayer);
  }

  getWithLegend(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.frontend?.legend);
  }

  getWithPanel(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.frontend?.panel);
  }

  getWithLayerSelector(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.frontend?.layerSelector);
  }

  getWithSearchCategory(): LoadedIntegrationMeta[] {
    return this.integrations.filter((i) => i.enabled && i.frontend?.searchCategory);
  }

  buildExclusionMap(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();

    for (const integration of this.integrations) {
      const overlay = integration.frontend?.overlay;
      if (!overlay) continue;
      map.set(integration.id, new Set(overlay.excludes ?? []));
    }

    for (const [id, excludes] of map) {
      for (const excluded of excludes) {
        if (!map.has(excluded)) {
          map.set(excluded, new Set());
        }
        map.get(excluded)?.add(id);
      }
    }

    return map;
  }
}
