import {
  assertValidFeedSlug,
  type BBox,
  isValidFeedSlug,
  normalizeFeedSlug,
  validatePublicUrl,
} from "@openmapx/core";
import { sql } from "./db";
import { dropGtfsSchema, type GtfsImportSource, hashGtfsArchive, importGtfsFeed } from "./importer";
import type { CatalogFeed, FeedStatus, ImportedFeed } from "./types";

/** Persisted schema names always have the `gtfs_<slug>` shape. Accept only slugs
 * that match the canonical form to prevent a malicious legacy row from feeding
 * raw SQL identifiers on load. */
function isValidSchemaName(schemaName: string): boolean {
  if (!schemaName.startsWith("gtfs_")) return false;
  return isValidFeedSlug(schemaName.slice("gtfs_".length));
}

// Metadata Table

const METADATA_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public.gtfs_feeds (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    origin_url TEXT,
    source TEXT NOT NULL,
    country_code TEXT,
    bbox JSONB,
    schema_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    feed_hash TEXT,
    imported_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    error_message TEXT,
    stop_count INTEGER,
    route_count INTEGER,
    trip_count INTEGER,
    service_end_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

// Additive columns. Run as separate IDEMPOTENT statements so older DBs that
// already have the table from the original DDL pick them up on next boot.
const METADATA_TABLE_ALTERS: string[] = [
  "ALTER TABLE public.gtfs_feeds ADD COLUMN IF NOT EXISTS license TEXT",
  "ALTER TABLE public.gtfs_feeds ADD COLUMN IF NOT EXISTS license_url TEXT",
  "ALTER TABLE public.gtfs_feeds ADD COLUMN IF NOT EXISTS mdb_id TEXT",
];

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

// postgres-js returns DATE columns as JS Date objects pegged to UTC midnight.
// `toISOString().slice(0,10)` would shift across timezones — read the UTC parts
// directly so the calendar day stays intact.
function formatDateOnly(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// GtfsManager

class GtfsManager {
  private feeds: Map<string, ImportedFeed> = new Map();
  private importing: Set<string> = new Set();
  private _initialized = false;

  get initialized(): boolean {
    return this._initialized;
  }

  /** Create metadata table and load existing feed states. */
  async initialize(): Promise<void> {
    try {
      await sql.unsafe(METADATA_TABLE_DDL);
      for (const stmt of METADATA_TABLE_ALTERS) {
        await sql.unsafe(stmt);
      }

      // Load existing feeds
      const rows = await sql.unsafe("SELECT * FROM public.gtfs_feeds ORDER BY slug");
      for (const row of rows) {
        const persistedSlug = row.slug as string;
        const persistedSchema = row.schema_name as string;
        if (!isValidFeedSlug(persistedSlug) || !isValidSchemaName(persistedSchema)) {
          console.warn(
            `[gtfs] Skipping feed row with invalid slug/schema: slug=${JSON.stringify(
              persistedSlug,
            )}, schema=${JSON.stringify(persistedSchema)}`,
          );
          continue;
        }
        const feed: ImportedFeed = {
          slug: persistedSlug,
          name: row.name as string,
          url: row.url as string,
          originUrl: (row.origin_url as string | null) ?? null,
          source: row.source as string,
          countryCode: (row.country_code as string) ?? "",
          schemaName: persistedSchema,
          status: row.status as FeedStatus,
          bbox: row.bbox as BBox | null,
          feedHash: row.feed_hash as string | null,
          importedAt: row.imported_at ? String(row.imported_at) : null,
          lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
          errorMessage: row.error_message as string | null,
          stopCount: row.stop_count as number | null,
          routeCount: row.route_count as number | null,
          tripCount: row.trip_count as number | null,
          serviceEndDate: row.service_end_date ? formatDateOnly(row.service_end_date) : null,
          currentStage: null,
          license: (row.license as string | null) ?? null,
          licenseUrl: (row.license_url as string | null) ?? null,
          mdbId: (row.mdb_id as string | null) ?? null,
        };
        this.feeds.set(feed.slug, feed);
      }

      // Mark any mid-import feeds as failed (server crashed during import)
      for (const feed of this.feeds.values()) {
        if (feed.status === "downloading" || feed.status === "importing") {
          feed.status = "failed";
          feed.errorMessage = "Import interrupted by server restart";
          await this.updateFeedStatus(feed.slug, "failed", "Import interrupted by server restart");
        }
      }

      this._initialized = true;
      console.log(`[gtfs] Initialized with ${this.feeds.size} feeds`);
    } catch (err) {
      console.warn("[gtfs] Failed to initialize (database may not be available):", err);
    }
  }

  /** Get all imported feeds. */
  getFeeds(): ImportedFeed[] {
    return [...this.feeds.values()];
  }

  /** Get active feeds that overlap a bounding box. */
  getActiveFeedsForBbox(bbox: BBox): ImportedFeed[] {
    const result: ImportedFeed[] = [];
    for (const feed of this.feeds.values()) {
      if (feed.status !== "active") continue;
      if (!feed.bbox) continue;
      if (bboxOverlaps(bbox, feed.bbox)) {
        result.push(feed);
      }
    }
    return result;
  }

  /** Find the schema for a stop ID prefix. */
  getSchemaForStopId(stopId: string): string | null {
    // Format: "g-<slug>:<original_stop_id>"
    if (!stopId.startsWith("g-")) return null;
    const colonIdx = stopId.indexOf(":");
    if (colonIdx < 3) return null;
    const slug = stopId.slice(2, colonIdx);
    const feed = this.feeds.get(slug);
    if (!feed || feed.status !== "active") return null;
    return feed.schemaName;
  }

  /** Extract original GTFS stop_id from our prefixed ID. */
  getOriginalStopId(stopId: string): string | null {
    if (!stopId.startsWith("g-")) return null;
    const colonIdx = stopId.indexOf(":");
    if (colonIdx < 3) return null;
    return stopId.slice(colonIdx + 1);
  }

  /** Get the slug from a prefixed stop ID. */
  getSlugFromStopId(stopId: string): string | null {
    if (!stopId.startsWith("g-")) return null;
    const colonIdx = stopId.indexOf(":");
    if (colonIdx < 3) return null;
    return stopId.slice(2, colonIdx);
  }

  /** Check if a feed is currently being imported. */
  isImporting(slug: string): boolean {
    return this.importing.has(slug);
  }

  /**
   * Import a GTFS feed (runs in background).
   * Returns immediately, import progress is tracked via feed status.
   *
   * `feed.url` is the canonical "where this feed came from" string and is
   * persisted in `gtfs_feeds.url`. When `feed.localPath` is set, the importer
   * reads the zip from that on-disk path instead of downloading — used for
   * promoting a MOTIS-fetched archive in `/data/gtfs/` into Postgres without
   * a redundant HTTP fetch. The url field is still persisted (typically a
   * `local:` pseudo-URL identifying the source archive) so the feed origin
   * stays self-describing.
   */
  async startImport(
    feed:
      | CatalogFeed
      | {
          name: string;
          url: string;
          source: string;
          countryCode: string;
          localPath?: string;
          /**
           * Upstream HTTP URL the feed was originally fetched from. Persisted
           * separately from `url` so a `local:<filename>` pseudo-URL doesn't
           * lose the origin when an operator promotes a MOTIS-fetched archive.
           */
          originUrl?: string;
        },
    slug?: string,
  ): Promise<string> {
    const feedSlug =
      slug ??
      (("id" in feed && normalizeFeedSlug((feed as CatalogFeed).id)) || `manual_${Date.now()}`);
    // Defense-in-depth: reject any slug that slipped past route-level validation
    // before it lands in a SQL identifier or filesystem path.
    assertValidFeedSlug(feedSlug);
    const schemaName = `gtfs_${feedSlug}`;

    if (this.importing.has(feedSlug)) {
      throw new Error(`Feed "${feedSlug}" is already being imported`);
    }

    const localPath = "localPath" in feed ? feed.localPath : undefined;
    const originUrl = "originUrl" in feed ? (feed.originUrl ?? null) : null;
    // CatalogFeed carries optional license metadata (set by MDB, sometimes by
    // Transitous). Persist it so the per-feed attribution surface and admin UI
    // can render the upstream license without a separate lookup.
    const licenseSpdx = "license" in feed ? ((feed.license as string | undefined) ?? null) : null;
    const licenseUrl =
      "licenseUrl" in feed ? ((feed.licenseUrl as string | undefined) ?? null) : null;
    const mdbId = "mdbId" in feed ? ((feed.mdbId as string | undefined) ?? null) : null;

    // Create or update metadata. Preserve any prior `currentStage` only
    // until the import actually starts emitting fresh stage updates.
    const previous = this.feeds.get(feedSlug);
    const importedFeed: ImportedFeed = {
      slug: feedSlug,
      name: feed.name,
      url: feed.url,
      // Prefer an explicit originUrl from the caller, fall back to whatever
      // we already had (preserves the upstream URL across re-imports that
      // didn't supply it again).
      originUrl: originUrl ?? previous?.originUrl ?? null,
      source: feed.source,
      countryCode: feed.countryCode ?? "",
      schemaName,
      status: "pending",
      bbox: previous?.bbox ?? null,
      feedHash: previous?.feedHash ?? null,
      importedAt: previous?.importedAt ?? null,
      lastCheckedAt: previous?.lastCheckedAt ?? null,
      errorMessage: null,
      stopCount: previous?.stopCount ?? null,
      routeCount: previous?.routeCount ?? null,
      tripCount: previous?.tripCount ?? null,
      serviceEndDate: previous?.serviceEndDate ?? null,
      currentStage: null,
      license: licenseSpdx ?? previous?.license ?? null,
      licenseUrl: licenseUrl ?? previous?.licenseUrl ?? null,
      mdbId: mdbId ?? previous?.mdbId ?? null,
    };
    this.feeds.set(feedSlug, importedFeed);

    await sql.unsafe(
      `INSERT INTO public.gtfs_feeds (slug, name, url, origin_url, source, country_code, schema_name, status, license, license_url, mdb_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
       ON CONFLICT (slug) DO UPDATE SET
         url = $3,
         origin_url = COALESCE($4, public.gtfs_feeds.origin_url),
         status = 'pending',
         error_message = NULL,
         license = COALESCE($8, public.gtfs_feeds.license),
         license_url = COALESCE($9, public.gtfs_feeds.license_url),
         mdb_id = COALESCE($10, public.gtfs_feeds.mdb_id),
         updated_at = NOW()`,
      [
        feedSlug,
        feed.name,
        feed.url,
        importedFeed.originUrl,
        feed.source,
        feed.countryCode ?? "",
        schemaName,
        licenseSpdx,
        licenseUrl,
        mdbId,
      ],
    );

    // Validate URL only when we'll actually fetch it; local-path imports
    // bypass HTTP entirely so SSRF / public-URL checks don't apply.
    if (!localPath) {
      validatePublicUrl(feed.url);
    }

    // Run import in background
    this.importing.add(feedSlug);
    const source: GtfsImportSource = localPath
      ? { kind: "localPath", path: localPath }
      : { kind: "url", url: feed.url };
    this.runImport(feedSlug, source, schemaName).catch((err) => {
      console.error(`[gtfs] Import of "${feedSlug}" failed:`, err);
    });

    return feedSlug;
  }

  private async runImport(slug: string, source: GtfsImportSource, schema: string): Promise<void> {
    try {
      await this.updateFeedStatus(slug, "downloading");

      // Fast-path for unchanged local archives. The importer's full pipeline
      // takes 5–30 minutes per feed and DROPs/recreates the schema even when
      // the bytes haven't moved. For the local-path case (operator promoting
      // a MOTIS-fetched archive) we can sha256 the zip up front and short-
      // circuit when it matches the previously persisted feed_hash. URL
      // imports always fetch — without an ETag/Last-Modified probe we'd
      // have to download the whole zip just to hash it, defeating the point.
      if (source.kind === "localPath") {
        const previous = this.feeds.get(slug);
        if (previous?.feedHash && previous.status === "active") {
          let currentHash: string;
          try {
            currentHash = hashGtfsArchive(source.path);
          } catch (err) {
            // Fall through into the normal import path; the importer reports
            // a clearer error if the archive is gone.
            console.warn(`[gtfs] hash check for "${slug}" failed, running full import:`, err);
            currentHash = "";
          }
          if (currentHash && currentHash === previous.feedHash) {
            const now = new Date().toISOString();
            await sql.unsafe(
              `UPDATE public.gtfs_feeds SET status = 'active', last_checked_at = NOW(), error_message = NULL, updated_at = NOW() WHERE slug = $1`,
              [slug],
            );
            previous.status = "active";
            previous.lastCheckedAt = now;
            previous.errorMessage = null;
            previous.currentStage = null;
            console.log(
              `[gtfs] "${slug}" already at hash ${currentHash.slice(0, 12)}…, skipped re-import`,
            );
            return;
          }
        }
      }

      const result = await importGtfsFeed(source, schema, (stage) => {
        const status = stage.includes("download") ? "downloading" : "importing";
        this.updateFeedStatus(slug, status).catch(() => {});
        const feed = this.feeds.get(slug);
        if (feed) {
          feed.status = status;
          feed.currentStage = stage;
        }
      });

      // Update metadata with results
      const now = new Date().toISOString();
      await sql.unsafe(
        `UPDATE public.gtfs_feeds SET
          status = 'active',
          bbox = $1::jsonb,
          feed_hash = $2,
          imported_at = NOW(),
          last_checked_at = NOW(),
          stop_count = $3,
          route_count = $4,
          trip_count = $5,
          service_end_date = $6::date,
          error_message = NULL,
          updated_at = NOW()
        WHERE slug = $7`,
        [
          result.bbox ? JSON.stringify(result.bbox) : null,
          result.hash,
          result.stopCount,
          result.routeCount,
          result.tripCount,
          result.serviceEndDate,
          slug,
        ],
      );

      const feed = this.feeds.get(slug);
      if (feed) {
        feed.status = "active";
        feed.bbox = result.bbox;
        feed.feedHash = result.hash;
        feed.importedAt = now;
        feed.lastCheckedAt = now;
        feed.stopCount = result.stopCount;
        feed.routeCount = result.routeCount;
        feed.tripCount = result.tripCount;
        feed.serviceEndDate = result.serviceEndDate;
        feed.errorMessage = null;
        feed.currentStage = null;
      }

      console.log(
        `[gtfs] Successfully imported "${slug}": ${result.stopCount} stops, ${result.routeCount} routes, ${result.tripCount} trips`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.updateFeedStatus(slug, "failed", message);

      const feed = this.feeds.get(slug);
      if (feed) {
        feed.status = "failed";
        feed.errorMessage = message;
        feed.currentStage = null;
      }

      // Don't drop the live schema on failure: with the atomic-swap import
      // the live schema isn't touched until the very end, so any data here
      // is the previous successful import — losing it on a transient failure
      // (network blip, malformed CSV, OOM) is worse than leaving the feed
      // marked "failed" while still serving the old version. The importer's
      // own catch already cleans up the staging schema.

      console.error(`[gtfs] Import failed for "${slug}":`, message);
    } finally {
      this.importing.delete(slug);
    }
  }

  /** Remove an imported feed (drop schema + delete metadata). */
  async removeFeed(slug: string): Promise<void> {
    const feed = this.feeds.get(slug);
    if (!feed) throw new Error(`Feed "${slug}" not found`);
    if (this.importing.has(slug)) throw new Error(`Feed "${slug}" is currently being imported`);

    await dropGtfsSchema(feed.schemaName);
    await sql.unsafe("DELETE FROM public.gtfs_feeds WHERE slug = $1", [slug]);
    this.feeds.delete(slug);
  }

  private async updateFeedStatus(
    slug: string,
    status: FeedStatus,
    errorMessage?: string,
  ): Promise<void> {
    await sql.unsafe(
      `UPDATE public.gtfs_feeds SET status = $1, error_message = $2, updated_at = NOW() WHERE slug = $3`,
      [status, errorMessage ?? null, slug],
    );
  }
}

export const gtfsManager = new GtfsManager();
