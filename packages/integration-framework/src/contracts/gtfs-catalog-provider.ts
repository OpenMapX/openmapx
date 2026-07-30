import type { BBox } from "@openmapx/core";

/**
 * Catalog entry surfaced by a `gtfs-catalog` discovery provider. Operators can
 * inspect these entries and add suitable schedule URLs through the
 * transactional data-manager source lifecycle. Richer fields (`mdbId`,
 * `latestDatasetUrl`, …) are provider-specific and optional.
 */
export interface GtfsCatalogFeed {
  id: string;
  name: string;
  source: string;
  countryCode: string;
  url: string;
  license?: string;
  bbox?: BBox;

  mdbId?: string;
  licenseUrl?: string;
  latestDatasetUrl?: string;
  latestDatasetHash?: string;
  latestDatasetDownloadedAt?: string;
  isOfficial?: boolean;
  /** "gtfs" | "gtfs_rt" | "gbfs" — distinguishes sub-types in catalogs that mix them. */
  dataType?: string;
}

export interface GtfsCatalogProvider {
  readonly id: string;
  listFeeds(): Promise<GtfsCatalogFeed[]>;
}
