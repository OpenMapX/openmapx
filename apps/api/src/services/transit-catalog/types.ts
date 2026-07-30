import type { BBox } from "@openmapx/core";

export interface TransitCatalogFeed {
  id: string;
  name: string;
  source: "transitous" | "mobilitydb" | "manual";
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
  dataType?: string;
}
