import type { IntegrationDataSource } from "@openmapx/integration-framework";
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
 * Manifest-declared data source — the curated authoritative description from an
 * integration's `manifest.json#dataSources[]`. Derived from the canonical
 * `IntegrationDataSource` (the Zod-validated manifest shape) via `Pick`, so its
 * field types — notably the `commercialUse` / `endUserExposure` enums — can never
 * drift from the schema. Narrowed to the fields the AttributionIndex surfaces:
 * `sourceId`/`name` stay required; the rest are optional because the index accepts
 * partially-populated rows (see `collectManifestDataSources`).
 */
export type ManifestDataSource = Pick<IntegrationDataSource, "sourceId" | "name"> &
  Partial<
    Pick<
      IntegrationDataSource,
      | "url"
      | "license"
      | "licenseUrl"
      | "attribution"
      | "commercialUse"
      | "providerCountry"
      | "providerPrivacyUrl"
      | "endUserExposure"
      | "personalData"
      | "cookies"
      | "dpaAvailable"
    >
  >;

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
