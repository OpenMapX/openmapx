/**
 * Mobility Database v1 response shapes. We only model the fields we actually
 * consume; everything else passes through untouched as `unknown`.
 *
 * Reference: https://mobilitydata.github.io/mobility-feed-api/SwaggerUI/index.html
 */

export type MdbFeedDataType = "gtfs" | "gtfs_rt" | "gbfs" | string;

export type MdbFeedStatus = "active" | "inactive" | "development" | "deprecated" | string;

export interface MdbLocation {
  country_code?: string;
  country?: string;
  subdivision_name?: string;
  municipality?: string;
}

export interface MdbSourceInfo {
  producer_url?: string;
  authentication_type?: 0 | 1 | 2;
  authentication_info_url?: string;
  api_key_parameter_name?: string;
  license_url?: string;
}

export interface MdbLatestDataset {
  id?: string;
  hosted_url?: string;
  downloaded_at?: string;
  hash?: string;
}

export interface MdbExternalId {
  external_id: string;
  source: string;
}

export interface MdbFeed {
  id: string;
  data_type: MdbFeedDataType;
  status?: MdbFeedStatus;
  provider?: string;
  feed_name?: string;
  note?: string;
  official?: boolean;
  source_info?: MdbSourceInfo;
  locations?: MdbLocation[];
  latest_dataset?: MdbLatestDataset;
  external_ids?: MdbExternalId[];
  redirects?: { target_id: string; comment?: string }[];
  feed_contact_email?: string;
  /** GTFS-RT-only: kinds of entity exposed by the feed. */
  entity_types?: string[];
  /** GTFS-RT-only: list of referenced GTFS schedule feed IDs. */
  feed_references?: string[];
  /** GBFS-only: list of supported versions, each with its own auto-discovery URL. */
  versions?: Array<{ version: string; url?: string }>;
}

export interface MdbTokenResponse {
  access_token: string;
  /** Expiration in seconds — some MDB builds use `expires_in`, others `expiration`. */
  expires_in?: number;
  expiration?: number;
  token_type?: string;
}
