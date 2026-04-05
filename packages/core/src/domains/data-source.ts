import type {
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "../types/dataSource";
import type { BoundingBox } from "../types/geometry";

export interface DataSourceProvider {
  readonly id: string;
  readonly meta: DataSourceMeta;
  readonly serviceIds?: string[];
  readonly searchCacheTtl?: number;
  readonly detailCacheTtl?: number;
  readonly coverage?: { countries?: string[]; bbox?: [number, number, number, number] };
  getFilters(): Promise<DataSourceFilterDef[]>;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]>;
  getDetail(itemId: string): Promise<DataSourceDetail>;
}
