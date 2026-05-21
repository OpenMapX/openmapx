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
