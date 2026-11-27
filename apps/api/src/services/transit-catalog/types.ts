import type { BBox } from "@openmapx/core";
import type { Licensing } from "@openmapx/mobility-core/licensing";

export interface TransitCatalogFeed {
  id: string;
  installedSourceId?: string | null;
  discoveryIds?: string[];
  name: string;
  /** `transitous`, `mobilitydb` or `manual` for the built-in catalogues, otherwise an installed one's. */
  source: string;
  countryCode: string;
  url: string;
  licensing?: Licensing;
  bbox?: BBox;
  mdbId?: string;
  latestDatasetUrl?: string;
  latestDatasetHash?: string;
  latestDatasetDownloadedAt?: string;
  isOfficial?: boolean;
  dataType?: string;
}
