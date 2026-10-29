import type { BBox } from "@openmapx/core";
import type { Licensing } from "@openmapx/mobility-core/licensing";

export interface TransitCatalogFeed {
  id: string;
  name: string;
  source: "transitous" | "mobilitydb" | "manual";
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
