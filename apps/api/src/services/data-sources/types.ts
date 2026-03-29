import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";

export interface DataSourceProvider {
  readonly id: string;
  readonly meta: DataSourceMeta;
  /** Service registry IDs this provider depends on. Used to filter unavailable sources. */
  readonly serviceIds?: string[];
  /** Redis cache TTL in seconds for search results. Default: 21600 (6h). */
  readonly searchCacheTtl?: number;
  /** Redis cache TTL in seconds for detail results. Default: 21600 (6h). */
  readonly detailCacheTtl?: number;
  getFilters(): Promise<DataSourceFilterDef[]>;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]>;
  getDetail(itemId: string): Promise<DataSourceDetail>;
}
