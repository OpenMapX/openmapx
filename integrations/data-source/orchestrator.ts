import { createHash } from "node:crypto";
import type {
  IntegrationContext,
  MobilityDataSourceProvider,
} from "@openmapx/integration-framework";

const DEFAULT_SEARCH_TTL = 21600;
const DEFAULT_DETAIL_TTL = 21600;
const DEFAULT_MAP_CONTEXT_TTL = 300;
const FILTER_TTL = 172800;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

export function createDataSourceOrchestrator(ctx: IntegrationContext) {
  function getAllProviders(): MobilityDataSourceProvider[] {
    const integrations = ctx.getIntegrationsByDomain("data-source");
    const providers: MobilityDataSourceProvider[] = [];
    for (const integration of integrations) {
      const domainProviders = (integration.providers.get("data-source") ??
        []) as MobilityDataSourceProvider[];
      providers.push(...domainProviders);
    }
    return providers;
  }

  function getProvider(id: string): MobilityDataSourceProvider | undefined {
    return getAllProviders().find((p) => p.id === id);
  }

  async function listWithFilters() {
    const integrations = ctx.getIntegrationsByDomain("data-source");
    const results: {
      id: string;
      name: string;
      categoryChipLabel: string;
      filters: unknown;
    }[] = [];

    for (const integration of integrations) {
      const domainProviders = (integration.providers.get("data-source") ??
        []) as MobilityDataSourceProvider[];
      const id = integration.manifest.id;
      const name = integration.manifest.frontend?.searchCategory?.label ?? id;

      for (const p of domainProviders) {
        const filters = await ctx.cache.withCache(`ds:filters:${p.id}`, FILTER_TTL, () =>
          p.getFilters(),
        );
        results.push({ ...p.meta, id, name, categoryChipLabel: name, filters });
      }
    }

    return results;
  }

  function getSearchTtl(provider: MobilityDataSourceProvider): number {
    return provider.searchCacheTtl ?? DEFAULT_SEARCH_TTL;
  }

  function getDetailTtl(provider: MobilityDataSourceProvider): number {
    return provider.detailCacheTtl ?? DEFAULT_DETAIL_TTL;
  }

  function getMapContextTtl(provider: MobilityDataSourceProvider): number {
    return provider.mapContextCacheTtl ?? DEFAULT_MAP_CONTEXT_TTL;
  }

  function searchCacheKey(
    providerId: string,
    bbox: { south: number; west: number; north: number; east: number },
    filters?: Record<string, unknown>,
  ): string {
    const roundedBbox = `${round(bbox.south, 2)},${round(bbox.west, 2)},${round(bbox.north, 2)},${round(bbox.east, 2)}`;
    const filterHash = filters ? hashKey("f", filters) : "none";
    return `ds:search:${providerId}:${roundedBbox}:${filterHash}`;
  }

  function detailCacheKey(providerId: string, itemId: string): string {
    const safeItemId = itemId.length > 200 ? hashKey("", itemId) : itemId;
    return `ds:detail:${providerId}:${safeItemId}`;
  }

  function mapContextCacheKey(
    providerId: string,
    bbox: { south: number; west: number; north: number; east: number },
    filters?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): string {
    const roundedBbox = `${round(bbox.south, 2)},${round(bbox.west, 2)},${round(bbox.north, 2)},${round(bbox.east, 2)}`;
    const filterHash = filters ? hashKey("f", filters) : "none";
    const optionsHash = options ? hashKey("o", options) : "none";
    return `ds:map-context:${providerId}:${roundedBbox}:${filterHash}:${optionsHash}`;
  }

  return {
    getAllProviders,
    getProvider,
    listWithFilters,
    getSearchTtl,
    getDetailTtl,
    getMapContextTtl,
    searchCacheKey,
    detailCacheKey,
    mapContextCacheKey,
  };
}
