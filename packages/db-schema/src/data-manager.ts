import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * `data_manager` Postgres schema — owned by the `services/data-manager`
 * container. The `apps/api` Drizzle config generates and applies the
 * migrations because the migration toolchain currently lives there; the
 * data-manager binary connects to the same database and inserts rows.
 */
export const dataManager = pgSchema("data_manager");

export const jobs = dataManager.table(
  "jobs",
  {
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
    executionVersion: integer("execution_version"),
    operationKey: text("operation_key"),
    operationFingerprint: text("operation_fingerprint"),
    executionFingerprint: text("execution_fingerprint"),
    admittedAt: bigint("admitted_at", { mode: "number" }),
    deadlineAt: bigint("deadline_at", { mode: "number" }),
    requestedDeadlineAt: bigint("requested_deadline_at", { mode: "number" }),
    executionParent: jsonb("execution_parent"),
    executionInput: jsonb("execution_input"),
    executionState: jsonb("execution_state"),
    executionChildren: jsonb("execution_children").notNull().default([]),
    ownershipVersion: integer("ownership_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("data_manager_jobs_execution_key_uq")
      .on(table.operationKey)
      .where(sql`${table.operationKey} IS NOT NULL`),
    uniqueIndex("data_manager_jobs_configuration_maintenance_uq")
      .on(sql`(${table.metadata}->'configurationMaintenance'->'receipt'->>'maintenanceId')`)
      .where(sql`${table.kind} = 'configuration-maintenance'`),
    uniqueIndex("data_manager_jobs_configuration_guard_uq")
      .on(table.kind)
      .where(
        sql`${table.kind} = 'configuration-maintenance' AND coalesce(${table.metadata}->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled'`,
      ),
    check(
      "data_manager_jobs_execution_bounds",
      sql`${table.ownershipVersion} >= 0 AND jsonb_typeof(${table.executionChildren}) = 'array' AND jsonb_array_length(${table.executionChildren}) <= 32 AND octet_length(${table.executionChildren}::text) <= 131072`,
    ),
    check(
      "data_manager_jobs_execution_shape",
      sql`${table.executionVersion} IS NULL OR coalesce((${table.executionVersion} = 2 AND ${table.operationKey} ~ '^opk1_[A-Za-z0-9_-]{16,64}$' AND ${table.operationFingerprint} ~ '^[a-f0-9]{64}$' AND ${table.executionFingerprint} ~ '^[a-f0-9]{64}$' AND ${table.admittedAt} >= 0 AND ${table.deadlineAt} > ${table.admittedAt} AND ${table.executionInput} IS NOT NULL AND ${table.executionState} IS NOT NULL), false)`,
    ),
    check(
      "data_manager_jobs_configuration_guard_shape",
      sql`${table.kind} <> 'configuration-maintenance' OR coalesce((jsonb_typeof(${table.metadata}->'configurationMaintenance') = 'object' AND ${table.metadata}->'configurationMaintenance'->>'version' = '1' AND ${table.metadata}->'configurationMaintenance'->>'guardState' IN ('preparing','prepared','settling','settled','recovery_required') AND jsonb_typeof(${table.metadata}->'configurationMaintenance'->'receipt') = 'object' AND octet_length((${table.metadata}->'configurationMaintenance')::text) <= 65536), false)`,
    ),
  ],
);

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

/** Durable physical offline-package work. Opaque principals live only in the owner table. */
export const offlinePackageJobs = dataManager.table(
  "offline_package_jobs",
  {
    id: uuid("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    packageId: text("package_id").notNull(),
    request: jsonb("request").notNull(),
    status: text("status").notNull(),
    manifest: jsonb("manifest"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("offline_package_jobs_live_request_key_uq")
      .on(table.requestKey)
      .where(sql`${table.status} IN ('preparing', 'ready-to-download')`),
    index("offline_package_jobs_status_created_idx").on(table.status, table.createdAt),
    index("offline_package_jobs_package_id_idx").on(table.packageId),
  ],
);

/** Many opaque principals may independently own/account for one deduplicated physical job. */
export const offlinePackageJobOwners = dataManager.table(
  "offline_package_job_owners",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => offlinePackageJobs.id, { onDelete: "cascade" }),
    principal: text("principal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.principal] }),
    index("offline_package_job_owners_principal_idx").on(table.principal),
  ],
);

/** Logical retention is charged once per principal/reference even when bytes are shared. */
export const offlinePackageArtifactReferences = dataManager.table(
  "offline_package_artifact_references",
  {
    principal: text("principal").notNull(),
    packageId: text("package_id").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    retainedAt: timestamp("retained_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.principal, table.packageId] }),
    index("offline_package_artifact_refs_package_idx").on(table.packageId),
    index("offline_package_artifact_refs_principal_age_idx").on(table.principal, table.retainedAt),
  ],
);
