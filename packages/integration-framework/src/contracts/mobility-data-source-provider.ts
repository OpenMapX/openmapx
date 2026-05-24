import type { BoundingBox, LngLat, OsmFilter } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";

export interface DataSourceAttribution {
  text: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

export interface DataSourceBranding {
  name?: string;
  legalName?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  color?: string;
  imageUrl?: string;
  imageUrlDark?: string;
}

export interface DataSourceMapContextSelection {
  systemIds?: string[];
  vehicleTypeIds?: string[];
}

export type DataSourceGeoJsonGeometry =
  | {
      type: "Polygon";
      coordinates: number[][][];
    }
  | {
      type: "MultiPolygon";
      coordinates: number[][][][];
    };

export interface DataSourceGeoJsonFeature {
  type: "Feature";
  geometry: DataSourceGeoJsonGeometry;
  properties: Record<string, unknown> | null;
}

export interface DataSourceGeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: DataSourceGeoJsonFeature[];
}

export interface DataSourceMapContext {
  geojson: DataSourceGeoJsonFeatureCollection;
}

export interface DataSourceMarkerStyle {
  variantColors: Record<string, string>;
  defaultColor: string;
  inactiveOpacity: number;
  iconPath: string;
  /** Marker rendering type. "circle" (default) renders colored dots. "icon" renders SVG icon markers with text labels. */
  type?: "circle" | "icon";
}

export interface DataSourceMeta {
  minZoom: number;
  markerStyle: DataSourceMarkerStyle;
  /** When true, the filter panel shows individual result cards below the filters. */
  showResultsList?: boolean;
  /** Human-readable category name for the Place panel (e.g., "Gas Station"). */
  placeCategory: string;
  /** Raw category string for data source matching (e.g., "fuel"). */
  placeCategoryRaw: string;
  /** Overpass OSM tag filters used to find the corresponding OSM node near a clicked item.
   *  When set, the place panel enriches with data from the matching OSM element instead
   *  of a plain reverse geocode. Omit for sources with no reliable OSM equivalent (webcams, scooters). */
  osmFilters?: OsmFilter[];
}

export interface DataSourceFilterDef {
  id: string;
  label: string;
  type: "multi-select" | "toggle";
  options?: { id: string | number; label: string; icon?: string }[];
  /** When true, this filter is applied client-side on the result set rather than
   *  being sent to the API. Providers set this for filters that cannot be
   *  efficiently evaluated server-side (e.g. speed derived from mapped variants). */
  clientSide?: boolean;
}

export interface DataSourceResult {
  id: string;
  name: string;
  coordinates: LngLat;
  source: string;
  /** All contributing source ids when a result merges records from multiple providers. */
  sources?: string[];
  /** Per-result attribution used by map/source attribution controls when a provider varies by item. */
  attributions?: DataSourceAttribution[];
  /**
   * Distinguishes fixed installations from free-floating items so the place
   * resolver can decide whether to snap to an OSM POI (via `osmFilters`) or
   * fall through to a plain reverse-geocode. Producers that already use the
   * shared-mobility mappers carry the same distinction in the result `id`
   * via an `s:`/`v:` prefix; non-mobility data sources (fuel, EV charging,
   * webcams) leave this unset.
   */
  kind?: "station" | "vehicle";
  variant: string;
  status?: string;
  summary?: string;
  operator?: string;
  branding?: DataSourceBranding;
  mapContext?: DataSourceMapContextSelection;
  /** Structured numeric values for client-side sorting (e.g., fuel prices by type). */
  sortValues?: Record<string, number>;
}

export interface PricingPlanEntry {
  /** Human-readable plan name, or empty string to render a generic fallback label. */
  name: string;
  description?: string;
  currency: string;
  unlockFee?: number;
  perKm?: number;
  perHour?: number;
  free?: boolean;
}

export interface DataSourceDetailSection {
  title: string;
  type: "table" | "list" | "text" | "image" | "embed" | "pricing";
  columns?: string[];
  rows?: (string | number)[][];
  items?: string[];
  content?: string;
  /** Image URL for type "image". Rendered as a safe <img> element. */
  imageUrl?: string;
  /** Alt text for image sections. */
  imageAlt?: string;
  /** Link URL. For "image" sections, wraps the image in an anchor tag. */
  linkUrl?: string;
  /** Embed URL for type "embed". Rendered as a sandboxed iframe or video element. */
  embedUrl?: string;
  /** Embed content type. Defaults to "iframe". "video" renders a video element. */
  embedType?: "iframe" | "video";
  /** Icon type for the section header. */
  sectionIcon?:
    | "bolt"
    | "fuel"
    | "access_time"
    | "info"
    | "directions_bus"
    | "directions_car"
    | "payments"
    | "eco"
    | "open_in_new"
    | "videocam"
    | "warning";
  /** Structured pricing plans for type "pricing". */
  pricingPlans?: PricingPlanEntry[];
  /** When true, the section renders collapsed by default. Embed sections default collapsed in the web UI. */
  collapsed?: boolean;
}

export interface DataSourceDetail {
  id: string;
  sources: string[];
  name: string;
  coordinates: LngLat;
  address?: {
    line1?: string;
    town?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  operator?: { name: string; url?: string; legalName?: string };
  /** Per-record attribution that cannot be expressed statically in the integration manifest. */
  attributions?: DataSourceAttribution[];
  branding?: DataSourceBranding;
  usageInfo?: { type: string; cost?: string; membershipRequired?: boolean };
  /** OSM-format opening hours string (e.g., "Mo-Fr 06:00-20:00; Sa-Su 08:00-20:00"). */
  openingHours?: string;
  sections: DataSourceDetailSection[];
  osmTags?: Record<string, string>;
  /**
   * When true, the detail view should render a "Nearby Transit" section that
   * fetches public transit lines within walking distance of the coordinates.
   * Set by data sources that produce Park+Ride facilities.
   */
  parkAndRide?: boolean;
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
