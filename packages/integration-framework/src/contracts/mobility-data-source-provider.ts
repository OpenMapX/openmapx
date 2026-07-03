import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";

export type {
  DataSourceAttribution,
  DataSourceBranding,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceFilterDef,
  DataSourceGeoJsonFeature,
  DataSourceGeoJsonFeatureCollection,
  DataSourceGeoJsonGeometry,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMarkerStyle,
  DataSourceMeta,
  DataSourceResult,
  OsmIdentity,
  PricingPlanEntry,
} from "@openmapx/core";

export interface MobilityDataSourceProvider {
  readonly id: string;
  readonly meta: DataSourceMeta;
  readonly serviceIds?: string[];
  readonly searchCacheTtl?: number;
  readonly detailCacheTtl?: number;
  readonly mapContextCacheTtl?: number;
  readonly coverage?: { countries?: string[]; bbox?: [number, number, number, number] };
  /**
   * Declared integration-level attribution. Mirrors what the provider attaches
   * to every {@link MobilityResult} it returns. Per-result attribution for
   * results that aggregate multiple upstream sources is carried on each
   * {@link DataSourceResult} via the `sources` / `attributions` fields.
   */
  readonly attribution: Attribution[];

  getFilters(): Promise<DataSourceFilterDef[]>;
  search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>>;
  getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>>;
  getMapContext?(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
    options?: DataSourceMapContextSelection,
  ): Promise<MobilityResult<DataSourceMapContext | null>>;
}
