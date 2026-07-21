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
  /**
   * Optional bulk canonical query used by charge-planning: returns the
   * integration's merged domain model for `bbox` (e.g. EvChargingStation[])
   * before it is projected to DataSourceResult. Only providers whose model
   * carries data the generic list projection drops (per-connector power/type)
   * implement this. Callers duck-type it via getIntegrationsByDomain.
   */
  searchStations?(bbox: BoundingBox): Promise<unknown[]>;
}
