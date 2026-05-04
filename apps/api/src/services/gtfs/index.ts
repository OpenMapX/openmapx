import {
  assertValidFeedSlug,
  type BBox,
  isValidFeedSlug,
  normalizeFeedSlug,
  validatePublicUrl,
} from "@openmapx/core";
import { sql } from "./db";
import { dropGtfsSchema, type GtfsImportSource, importGtfsFeed } from "./importer";
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
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
      | { name: string; url: string; source: string; countryCode: string; localPath?: string },
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

    // Create or update metadata
    const importedFeed: ImportedFeed = {
      slug: feedSlug,
      name: feed.name,
      url: feed.url,
      source: feed.source,
      countryCode: feed.countryCode ?? "",
      schemaName,
      status: "pending",
      bbox: null,
      feedHash: null,
      importedAt: null,
      lastCheckedAt: null,
      errorMessage: null,
      stopCount: null,
      routeCount: null,
      tripCount: null,
    };
    this.feeds.set(feedSlug, importedFeed);

    await sql.unsafe(
      `INSERT INTO public.gtfs_feeds (slug, name, url, source, country_code, schema_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (slug) DO UPDATE SET
         url = $3, status = 'pending', error_message = NULL, updated_at = NOW()`,
      [feedSlug, feed.name, feed.url, feed.source, feed.countryCode ?? "", schemaName],
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

      const result = await importGtfsFeed(source, schema, (stage) => {
        const status = stage.includes("download") ? "downloading" : "importing";
        this.updateFeedStatus(slug, status).catch(() => {});
        const feed = this.feeds.get(slug);
        if (feed) feed.status = status;
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
          error_message = NULL,
          updated_at = NOW()
        WHERE slug = $6`,
        [
          result.bbox ? JSON.stringify(result.bbox) : null,
          result.hash,
          result.stopCount,
          result.routeCount,
          result.tripCount,
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
        feed.errorMessage = null;
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
      }

      // Clean up partial schema on failure
      try {
        await dropGtfsSchema(schema);
      } catch {
        // ignore
      }

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
