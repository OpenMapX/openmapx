/**
 * Attribution metadata for a single data source that contributed to a result.
 * Designed as the canonical attribution shape across transit, shared-mobility,
 * parking, fuel, ev-charging, and any future domain. Every provider returns
 * one or more Attributions on every MobilityResult.
 */
export interface Attribution {
  /** Stable identifier registered in the framework's data-source registry. */
  sourceId: string;
  /** Human-readable name. */
  name: string;
  /** Canonical homepage / data portal. */
  url?: string;
  /** SPDX identifier where known. */
  spdxLicense?: string;
  /** Stable link to the license text. */
  licenseUrl?: string;
  /** Verbatim attribution text required by some licenses (render unmodified). */
  attributionText?: string;
  /** Upstream publisher. */
  publisher?: { name: string; url?: string };
  /** When this data was last refreshed from upstream (ISO 8601). */
  retrievedAt?: string;
  /** Free-form per-source notes (e.g. "via Transitous feed proxy"). */
  notes?: string;
}

export interface DataSourceAttribution {
  /** Canonical identity when supplied by newer adapters; absent in legacy data. */
  sourceId?: string;
  text: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

/** Standard receipt for a proven OpenStreetMap dataset, independent of transport host. */
export const OPENSTREETMAP_ATTRIBUTION: Readonly<Attribution> = Object.freeze({
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
});
