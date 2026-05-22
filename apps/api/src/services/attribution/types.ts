import type { Attribution } from "@openmapx/mobility-core/attribution";

/**
 * One row in the MOTIS license.json file, exactly as Transitous emits it.
 * The file is an array of these objects (one per ingested feed file).
 */
export interface MotisLicenseEntry {
  country_code?: string;
  country_name?: string;
  region_code?: string;
  region_name?: string;
  subdivision_code?: string;
  subdivision_name?: string;
  /** e.g. "de_DELFI.gtfs.zip" — the key used for byMotisFilename lookups. */
  filename: string;
  human_name?: string;
  /** Upstream URL (e.g. the canonical feed download). */
  source?: string;
  spdx_license_identifier?: string;
  license_url?: string;
  attribution_text?: string;
  publisher?: { name?: string; url?: string };
  operators?: Array<{ name?: string; url?: string }>;
  contacts?: Array<{ name?: string; email?: string; url?: string }>;
  rt?: Array<{
    source?: string;
    spdx_license_identifier?: string;
    license_url?: string;
    publisher?: { name?: string; url?: string };
  }>;
}

/**
 * Manifest-declared data source — the curated authoritative description from
 * an integration's `manifest.json#dataSources[]`. Mirrors the shape from
 * `@openmapx/integration-framework`'s `IntegrationDataSource`, narrowed to the
 * fields the AttributionIndex actually surfaces (we accept extras at runtime).
 */
export interface ManifestDataSource {
  sourceId: string;
  name: string;
  url?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  commercialUse?: "yes" | "no" | "depends" | "conditional" | "unknown";
  providerCountry?: string;
  providerPrivacyUrl?: string;
  endUserExposure?: "ui" | "server-only" | "data" | "direct" | "mixed" | "proxied" | "build-time";
  personalData?: boolean;
  cookies?: boolean;
  dpaAvailable?: boolean;
}

/**
 * Fully resolved attribution record returned by the AttributionIndex.
 * Extends the canonical `Attribution` shape with a discriminator describing
 * the origin and the original source record for drill-down UIs.
 */
export interface ResolvedAttribution extends Attribution {
  /** Where this resolution came from. */
  source: "motis-license" | "integration-manifest";
  /** Original source-specific record for deep-drill UI. */
  raw?: MotisLicenseEntry | ManifestDataSource;
}
