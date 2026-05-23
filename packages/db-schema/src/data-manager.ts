import { integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * `data_manager` Postgres schema — owned by the `services/data-manager`
 * container. The `apps/api` Drizzle config generates and applies the
 * migrations because the migration toolchain currently lives there; the
 * data-manager binary connects to the same database and inserts rows.
 */
export const dataManager = pgSchema("data_manager");

export const jobs = dataManager.table("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** e.g. "transitous-sync" */
  kind: text("kind").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** "running" | "ok" | "partial" | "error" */
  status: text("status").notNull(),
  /** "cron" | "manual:<user>" */
  triggeredBy: text("triggered_by"),
  /**
   * Client-supplied idempotency token. A POST /sync that replays the same
   * key within a 24h window (E7 contract) returns 409 instead of starting a
   * second pipeline. NULL when the caller did not supply a key (cron path).
   */
  idempotencyKey: text("idempotency_key"),
  /** { transitousRef, countries[], ... } */
  metadata: jsonb("metadata"),
});

export const jobStages = dataManager.table("job_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  /** StageName */
  stage: text("stage").notNull(),
  /** StageStatus */
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  message: text("message"),
  error: jsonb("error"),
  artifacts: jsonb("artifacts"),
});

export const feedState = dataManager.table("feed_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** e.g. "de" */
  region: text("region").notNull(),
  /** Source name from feeds/<region>.json */
  name: text("name").notNull(),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
  /** sha256 of latest fetched archive */
  hash: text("hash"),
  /** "ok" | "warning" | "error" */
  validationStatus: text("validation_status"),
  validationMessage: text("validation_message"),
  /** "active" | "stale" | "failed" | "unknown" */
  status: text("status").notNull().default("unknown"),
  /**
   * Number of consecutive validation failures since the last successful
   * validation. Reset to 0 on `validation_status = 'ok'`. Drives the
   * staleness-alert cron (G2) — at >= 3 consecutive failures we emit a
   * structured warning + (optional) GitHub Issue.
   */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
});

export const poiFeedState = dataManager.table("poi_feed_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Registry id from POI_SOURCES (e.g. "bnetza-ev", "utmc-newcastle-parking"). */
  sourceId: text("source_id").notNull().unique(),
  /** Domain bucket from PoiSource.domain — "ev-charging" | "parking" | future. */
  domain: text("domain").notNull(),
  lastStaticIngestAt: timestamp("last_static_ingest_at", { withTimezone: true }),
  lastStaticRowCount: integer("last_static_row_count"),
  /** Hash from BundledPoiSpec.staticChangeKey — drives the skip-swap-if-unchanged path. */
  lastStaticHash: text("last_static_hash"),
  lastLiveIngestAt: timestamp("last_live_ingest_at", { withTimezone: true }),
  lastLiveRowCount: integer("last_live_row_count"),
  /** "active" | "stale" | "failed" | "unknown" */
  status: text("status").notNull().default("unknown"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: jsonb("last_error"),
});
