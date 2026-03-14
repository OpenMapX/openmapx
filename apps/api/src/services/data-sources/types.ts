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
  getFilters(): Promise<DataSourceFilterDef[]>;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]>;
  getDetail(itemId: string): Promise<DataSourceDetail>;
}
