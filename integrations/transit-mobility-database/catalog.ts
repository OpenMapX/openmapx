import type { MdbFeed } from "./types.js";

/**
 * Catalog-feed shape we contribute to `apps/api/src/services/gtfs/catalog.ts`.
 *
 * Structurally compatible with the existing `CatalogFeed` interface — the
 * additional MDB-only fields are optional and consumed only when
 * `source === "mobilitydb"`. The host module owns the canonical type; we
 * just shape data to match.
 */
export interface MdbCatalogFeed {
  id: string;
  name: string;
  source: "mobilitydb";
  countryCode: string;
  url: string;
  license?: string;
  /** Stable `mdb-XXXX` foreign key. */
  mdbId: string;
  /** Producer's published license URL when MDB knows it. */
  licenseUrl?: string;
  /** Daily-mirrored snapshot URL on files.mobilitydatabase.org. Rotates per snapshot — never persist. */
  latestDatasetUrl?: string;
  latestDatasetHash?: string;
  latestDatasetDownloadedAt?: string;
  /** Producer-confirmed feed flag. */
  isOfficial?: boolean;
  /** "gtfs" | "gtfs_rt" | "gbfs" */
  dataType: string;
}

/**
 * Best-effort SPDX guess from a license URL. The MDB schema only exposes
 * `license_url`; we want a short label for the importer to persist into
 * `gtfs_feeds.license`. Returns undefined when the URL doesn't match a
 * pattern we recognise — the import gate then treats the feed as
 * "license unknown".
 */
function inferSpdxFromLicenseUrl(licenseUrl: string | undefined): string | undefined {
  if (!licenseUrl) return undefined;
  const url = licenseUrl.toLowerCase();
  if (url.includes("creativecommons.org/publicdomain/zero")) return "CC0-1.0";
  if (url.includes("creativecommons.org/licenses/by-sa/4.0")) return "CC-BY-SA-4.0";
  if (url.includes("creativecommons.org/licenses/by/4.0")) return "CC-BY-4.0";
  if (url.includes("creativecommons.org/licenses/by/3.0")) return "CC-BY-3.0";
  if (url.includes("creativecommons.org/licenses/by-sa/3.0")) return "CC-BY-SA-3.0";
  if (url.includes("opendatacommons.org/licenses/odbl")) return "ODbL-1.0";
  if (url.includes("opendatacommons.org/licenses/by")) return "ODC-By-1.0";
  if (url.includes("apache.org/licenses/license-2.0")) return "Apache-2.0";
  return undefined;
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
    license: inferSpdxFromLicenseUrl(licenseUrl),
    mdbId: feed.id,
    licenseUrl,
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
