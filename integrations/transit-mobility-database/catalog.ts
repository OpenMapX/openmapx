import { type Licensing, licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { MdbFeed } from "./types.js";

/**
 * Catalog-feed shape contributed through the integration framework's generic
 * GTFS discovery contract. The additional MDB-only fields are optional.
 */
export interface MdbCatalogFeed {
  id: string;
  name: string;
  source: "mobilitydb";
  countryCode: string;
  url: string;
  licensing: Licensing;
  /** Stable `mdb-XXXX` foreign key. */
  mdbId: string;
  /** Daily-mirrored snapshot URL on files.mobilitydatabase.org. Rotates per snapshot — never persist. */
  latestDatasetUrl?: string;
  latestDatasetHash?: string;
  latestDatasetDownloadedAt?: string;
  /** Producer-confirmed feed flag. */
  isOfficial?: boolean;
  /** "gtfs" | "gtfs_rt" | "gbfs" */
  dataType: string;
}

function primaryLocation(feed: MdbFeed): {
  countryCode: string;
  subdivision?: string;
  municipality?: string;
} {
  const loc = feed.locations?.[0];
  return {
    countryCode: (loc?.country_code ?? "").toLowerCase(),
    subdivision: loc?.subdivision_name,
    municipality: loc?.municipality,
  };
}

function feedName(feed: MdbFeed): string {
  if (feed.feed_name && feed.provider) return `${feed.provider} — ${feed.feed_name}`;
  return feed.feed_name ?? feed.provider ?? feed.id;
}

/**
 * Normalize a producer URL into a stable dedup key. We compare against
 * Transitous's `url` field to avoid double-listing the same feed when
 * Transitous's source JSON already references the agency's HTTP URL.
 *
 *  - lower-case host + path
 *  - strip trailing slashes
 *  - collapse `http://` and `https://` (agencies migrate to TLS over time)
 *  - drop query strings (cache-busters add noise)
 */
export function normalizeProducerUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/** Map a raw MDB feed object to an `MdbCatalogFeed` row. */
export function toMdbCatalogFeed(feed: MdbFeed): MdbCatalogFeed | null {
  const url = feed.source_info?.producer_url ?? feed.latest_dataset?.hosted_url;
  if (!url) return null;
  if (feed.status === "deprecated" || feed.status === "inactive") return null;
  if (feed.source_info?.authentication_type) {
    // Authenticated upstreams need bilateral credentials we don't have.
    // Surface them only when we have a story for sourcing the key.
    return null;
  }

  const { countryCode } = primaryLocation(feed);
  const licenseUrl = feed.source_info?.license_url;
  return {
    id: `mobilitydb:${countryCode || "xx"}:${feed.id}`,
    name: feedName(feed),
    source: "mobilitydb",
    countryCode,
    url,
    licensing: licensingFromDeclaration(undefined, licenseUrl, feedName(feed)),
    mdbId: feed.id,
    latestDatasetUrl: feed.latest_dataset?.hosted_url,
    latestDatasetHash: feed.latest_dataset?.hash,
    latestDatasetDownloadedAt: feed.latest_dataset?.downloaded_at,
    isOfficial: feed.official === true,
    dataType: feed.data_type,
  };
}

/** Map an array of MDB feeds to catalog rows, dropping any we cannot ingest. */
export function toMdbCatalogFeeds(feeds: MdbFeed[]): MdbCatalogFeed[] {
  const result: MdbCatalogFeed[] = [];
  for (const f of feeds) {
    const mapped = toMdbCatalogFeed(f);
    if (mapped) result.push(mapped);
  }
  return result;
}
