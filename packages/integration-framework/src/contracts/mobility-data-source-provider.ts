import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourcePartialReason,
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
  DataSourcePartialReason,
  DataSourceResult,
  OsmIdentity,
  PricingPlanEntry,
} from "@openmapx/core";

/** A data-source search answer. */
export interface DataSourceSearchResult extends MobilityResult<DataSourceResult[]> {
  /**
   * Set when the area may hold results the answer lacks, saying why: `area`
   * when a source fetched only part of the view, so a narrower view or a
   * later read may fill them in; `unavailable` when a source did not answer.
   * The host never caches a partial answer and passes the reason to the client.
   */
  partial?: DataSourcePartialReason;
}

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

  /**
   * Whether the source can answer now, asked each time the data sources are
   * listed. A source that orchestrates other integrations' providers is
   * unavailable while none is registered; it is then not listed, so the
   * client offers no chip for it. Absent: always available.
   */
  isAvailable?(): boolean;

  getFilters(): Promise<DataSourceFilterDef[]>;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceSearchResult>;
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
