import type { BBox } from "@openmapx/core";

/**
 * Catalog entry for a GTFS feed surfaced by a `gtfs-catalog` provider. The
 * `apps/api/src/services/gtfs` importer consumes these to download + ingest
 * each schedule feed; richer fields (`mdbId`, `latestDatasetUrl`, …) are
 * provider-specific and optional.
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
