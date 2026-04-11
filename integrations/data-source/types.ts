import type { BoundingBox, LngLat } from "@openmapx/core";

export interface DataSourceAttribution {
  text: string;
  url: string;
  license?: string;
  licenseUrl?: string;
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
  id: string;
  name: string;
  attribution: DataSourceAttribution | DataSourceAttribution[];
  categoryChipLabel: string;
  minZoom: number;
  markerStyle: DataSourceMarkerStyle;
  /** When true, the filter panel shows individual result cards below the filters. */
  showResultsList?: boolean;
  /** Human-readable category name for the Place panel (e.g., "Gas Station"). */
  placeCategory: string;
  /** Raw category string for data source matching (e.g., "fuel"). */
  placeCategoryRaw: string;
}

export interface DataSourceFilterDef {
  id: string;
  label: string;
  type: "multi-select" | "toggle";
  options?: { id: string | number; label: string; icon?: string }[];
}

export interface DataSourceResult {
  id: string;
  name: string;
  coordinates: LngLat;
  source: string;
  variant: string;
  status?: string;
  summary?: string;
  operator?: string;
  /** Structured numeric values for client-side sorting (e.g., fuel prices by type). */
  sortValues?: Record<string, number>;
}

export interface DataSourceDetailSection {
  title: string;
  type: "table" | "list" | "text";
  columns?: string[];
  rows?: (string | number)[][];
  items?: string[];
  content?: string;
  /** Icon type for the section header. Defaults to "bolt" for backward compatibility. */
  sectionIcon?:
    | "bolt"
    | "fuel"
    | "access_time"
    | "info"
    | "directions_bus"
    | "directions_car"
    | "payments"
    | "eco"
    | "open_in_new";
  /** When true, the section renders collapsed by default with a toggle to expand. */
  collapsed?: boolean;
}

export interface DataSourceDetail {
  id: string;
  source: string;
  name: string;
  coordinates: LngLat;
  address?: {
    line1?: string;
    town?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  operator?: { name: string; url?: string };
  usageInfo?: { type: string; cost?: string; membershipRequired?: boolean };
  /** OSM-format opening hours string (e.g., "Mo-Fr 06:00-20:00; Sa-Su 08:00-20:00"). */
  openingHours?: string;
  attribution: DataSourceAttribution | DataSourceAttribution[];
  sections: DataSourceDetailSection[];
  osmTags?: Record<string, string>;
}

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
