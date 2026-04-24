import type {
  Gbfs as GbfsV23Discovery,
  FreeBikeStatus as GbfsV23FreeBikeStatus,
  StationInformation as GbfsV23StationInformation,
  StationStatus as GbfsV23StationStatus,
  SystemInformation as GbfsV23SystemInformation,
  SystemPricingPlans as GbfsV23SystemPricingPlans,
  VehicleTypes as GbfsV23VehicleTypes,
} from "gbfs-typescript-types/v2.3";
import type {
  Gbfs as GbfsV30Discovery,
  Manifest as GbfsV30Manifest,
  StationInformation as GbfsV30StationInformation,
  StationStatus as GbfsV30StationStatus,
  SystemInformation as GbfsV30SystemInformation,
  SystemPricingPlans as GbfsV30SystemPricingPlans,
  VehicleStatus as GbfsV30VehicleStatus,
  VehicleTypes as GbfsV30VehicleTypes,
} from "gbfs-typescript-types/v3.0";

export type {
  GbfsV23Discovery,
  GbfsV23FreeBikeStatus,
  GbfsV23StationInformation,
  GbfsV23StationStatus,
  GbfsV23SystemInformation,
  GbfsV23SystemPricingPlans,
  GbfsV23VehicleTypes,
  GbfsV30Discovery,
  GbfsV30Manifest,
  GbfsV30StationInformation,
  GbfsV30StationStatus,
  GbfsV30SystemInformation,
  GbfsV30SystemPricingPlans,
  GbfsV30VehicleStatus,
  GbfsV30VehicleTypes,
};

export type GbfsDiscoveryDocument = GbfsV23Discovery | GbfsV30Discovery;

export interface GbfsManifestDatasetVersion {
  systemId: string;
  version: string;
  url: string;
}

export interface GbfsFeedReference {
  name: string;
  url: string;
}

type LocalizedTextLike = string | { text?: unknown } | Array<{ text?: unknown }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractFeedsFromLanguageContainer(value: unknown): GbfsFeedReference[] {
  if (!isObject(value) || !Array.isArray(value.feeds)) return [];
  return value.feeds
    .filter((feed): feed is { name?: unknown; url?: unknown } => isObject(feed))
    .map((feed) => ({
      name: typeof feed.name === "string" ? feed.name : "",
      url: typeof feed.url === "string" ? feed.url : "",
    }))
    .filter((feed) => feed.name.length > 0 && feed.url.length > 0);
}

/**
 * Collect every GBFS feed reference from v2.x and v3 discovery documents.
 */
export function listGbfsFeeds(
  discovery: GbfsDiscoveryDocument | null | undefined,
): GbfsFeedReference[] {
  if (!discovery?.data || !isObject(discovery.data)) return [];

  if (Array.isArray((discovery.data as { feeds?: unknown }).feeds)) {
    return extractFeedsFromLanguageContainer(discovery.data);
  }

  const feeds: GbfsFeedReference[] = [];
  for (const value of Object.values(discovery.data)) {
    feeds.push(...extractFeedsFromLanguageContainer(value));
  }
  return feeds;
}

export function resolveGbfsFeedUrl(
  discovery: GbfsDiscoveryDocument | null | undefined,
  feedName: string,
): string | null {
  const feed = listGbfsFeeds(discovery).find((entry) => entry.name === feedName);
  return feed?.url ?? null;
}

export function resolveGbfsVehicleStatusFeedUrl(
  discovery: GbfsDiscoveryDocument | null | undefined,
): string | null {
  return (
    resolveGbfsFeedUrl(discovery, "vehicle_status") ??
    resolveGbfsFeedUrl(discovery, "free_bike_status")
  );
}

/**
 * GBFS v3 uses translated-string arrays for several fields. This helper keeps
 * callers tolerant across GBFS v2 strings, GBFS v3 translated strings, and a
 * few operator-specific quirks.
 */
export function gbfsLocalizedTextToString(value: LocalizedTextLike | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry?.text === "string");
    return typeof first?.text === "string" ? first.text : "";
  }
  return typeof value.text === "string" ? value.text : "";
}

/**
 * Extract GBFS v3 manifest dataset versions as a flat list.
 */
export function listGbfsManifestDatasetVersions(
  manifest: GbfsV30Manifest | null | undefined,
): GbfsManifestDatasetVersion[] {
  const datasets = manifest?.data?.datasets;
  if (!Array.isArray(datasets)) return [];

  return datasets.flatMap((dataset) => {
    const systemId = typeof dataset?.system_id === "string" ? dataset.system_id : "";
    if (!systemId || !Array.isArray(dataset?.versions)) return [];

    return dataset.versions
      .map((version) => ({
        systemId,
        version: typeof version?.version === "string" ? version.version : "",
        url: typeof version?.url === "string" ? version.url : "",
      }))
      .filter((entry) => entry.version.length > 0 && entry.url.length > 0);
  });
}
