import type { LoadedIntegrationMeta } from "./loader";

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
