import type { LngLat } from "./geometry";

export interface DataSourceAttribution {
  text: string;
  url: string;
  license?: string;
}

export interface DataSourceMarkerStyle {
  variantColors: Record<string, string>;
  defaultColor: string;
  inactiveOpacity: number;
  iconPath: string;
}

export interface DataSourceMeta {
  id: string;
  name: string;
  attribution: DataSourceAttribution;
  categoryChipLabel: string;
  minZoom: number;
  markerStyle: DataSourceMarkerStyle;
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
}

export interface DataSourceDetailSection {
  title: string;
  type: "table" | "list" | "text";
  columns?: string[];
  rows?: (string | number)[][];
  items?: string[];
  content?: string;
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
  attribution: DataSourceAttribution;
  sections: DataSourceDetailSection[];
  osmTags?: Record<string, string>;
}
