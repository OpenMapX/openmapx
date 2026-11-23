import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
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
 * data-manager binary connects to the same database, writes its job and feed
 * rows, and also creates and owns the PostGIS index schemas it builds.
 */
export const dataManager = pgSchema("data_manager");

export const jobs = dataManager.table(
  "jobs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    /** e.g. "transit-sync", "download-osm" */
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** "running" | "ok" | "partial" | "error" */
    status: text("status").notNull(),
    /**
     * `<trigger>:<actor>`, e.g. "cron:data-manager-cron" or "api:user:<user id>".
     * A user id here is personal data: retention prunes the row once it ages out.
     */
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
    /** Agent operations of in-process work: reserved at admission, recorded as
     * attempted before the request and as terminal once the agent answers. */
    executionAgentOperations: jsonb("execution_agent_operations").notNull().default([]),
    /** The execution row, inserted with the job row: the parts of its admission
     * the columns above do not carry (targets, planned and reserved children,
     * origin), fixed when recorded. */
    executionAdmission: jsonb("execution_admission"),
    /** The execution row's progress: phase, effect start, settlement (with the
     * terminal it committed) and one cell per reserved child, the job's only
     * record of its children: what the child acts on, its binding and grant,
     * and data-manager's record of it (cancellation, how it last observed the
     * child). The control kernel's changes never touch `ownership_version`;
     * data-manager's own child records change it like the job's status. */
    executionProgress: jsonb("execution_progress"),
    /** How the worker ended, recorded once after its work returned or failed,
     * or by recovery for a worker that died with its process. */
    executionCompletion: jsonb("execution_completion"),
    /** When a finished job released what it held (its own lease, if any);
     * startup recovery leaves the row alone from then on. */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    ownershipVersion: integer("ownership_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("jobs_operation_key_key")
      .on(table.operationKey)
      .where(sql`${table.operationKey} IS NOT NULL`),
    // The code bounds the progress's compact JSON at 256 KiB; jsonb's text form
    // adds a space after each separator, so it stays under twice that.
    check(
      "jobs_execution_bounds_check",
      sql`${table.ownershipVersion} >= 0 AND (${table.executionProgress} IS NULL OR octet_length(${table.executionProgress}::text) <= 524288)`,
    ),
    check(
      "jobs_execution_row_check",
      sql`(${table.executionAdmission} IS NULL) = (${table.executionProgress} IS NULL) AND (${table.executionAdmission} IS NULL OR ${table.executionVersion} = 2) AND (${table.executionVersion} IS DISTINCT FROM 2 OR ${table.executionAdmission} IS NOT NULL OR ${table.finishedAt} IS NOT NULL) AND (${table.executionCompletion} IS NULL OR ${table.executionAdmission} IS NOT NULL) AND (${table.releasedAt} IS NULL OR (${table.finishedAt} IS NOT NULL AND ${table.executionAdmission} IS NOT NULL))`,
    ),
    check(
      "jobs_execution_shape_check",
      sql`${table.executionVersion} IS NULL OR coalesce((${table.executionVersion} = 2 AND ${table.operationKey} ~ '^opk1_[A-Za-z0-9_-]{16,64}$' AND ${table.operationFingerprint} ~ '^[a-f0-9]{64}$' AND ${table.executionFingerprint} ~ '^[a-f0-9]{64}$' AND ${table.admittedAt} >= 0 AND ${table.deadlineAt} > ${table.admittedAt} AND ${table.executionInput} IS NOT NULL AND ${table.executionState} IS NOT NULL), false)`,
    ),
  ],
);

/**
 * The configuration fence: while a row is `prepared`, a configuration
 * maintenance owns the data plane and no data job is admitted. The agent
 * prepares and settles it; both calls are idempotent on the same body. The
 * row is data-manager's only record of the agent's fence child: a `refused`
 * row records that the preparation was refused before anything changed, so
 * the same request is refused again.
 */
export const configurationFence = dataManager.table(
  "configuration_fence",
  {
    maintenanceId: uuid("maintenance_id").primaryKey(),
    /** The agent's prepare execution id and operation key. */
    fenceId: uuid("fence_id").notNull().unique("configuration_fence_fence_id_key"),
    operationKey: text("operation_key").notNull().unique("configuration_fence_operation_key_key"),
    candidateId: uuid("candidate_id").notNull(),
    planDigest: text("plan_digest").notNull(),
    /** The prepare request body, compared on a repeated prepare. */
    input: jsonb("input").notNull(),
    /** "prepared" | "settled" | "refused" */
    state: text("state").notNull(),
    /** "applied" | "unused" | "contained", set by the settle. */
    outcome: text("outcome"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the row was settled or refused; a later preparation removes it after 72 hours. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("configuration_fence_state_prepared_key")
      .on(table.state)
      .where(sql`${table.state} = 'prepared'`),
    check(
      "configuration_fence_state_check",
      sql`(${table.state} = 'prepared' AND ${table.outcome} IS NULL AND ${table.settledAt} IS NULL) OR (${table.state} = 'settled' AND ${table.outcome} IN ('applied','unused','contained') AND ${table.settledAt} IS NOT NULL) OR (${table.state} = 'refused' AND ${table.outcome} IS NULL AND ${table.settledAt} IS NOT NULL)`,
    ),
  ],
);

export const jobStages = dataManager.table(
  "job_stages",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    jobId: uuid("job_id").notNull(),
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
  },
  // Deleting a job cascades here once per job row, and the job detail views
  // read stages by job. Without this index each of those is a full table scan.
  (table) => [
    foreignKey({
      name: "job_stages_job_id_fkey",
      columns: [table.jobId],
      foreignColumns: [jobs.id],
    }).onDelete("cascade"),
    index("job_stages_job_id_idx").on(table.jobId),
  ],
);

/** One row per transit feed source, keyed by its region and source name. */
export const feedState = dataManager.table(
  "feed_state",
  {
    /** e.g. "de" */
    region: text("region").notNull(),
    /** Source name from feeds/<region>.json */
    name: text("name").notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
    /** sha256 of the latest fetched archive */
    hash: text("hash"),
    /** "ok" | "warning" | "error" */
    validationStatus: text("validation_status"),
    validationMessage: text("validation_message"),
    /** "active" | "stale" | "failed" | "unknown" */
    status: text("status").notNull().default("unknown"),
    /**
     * Number of consecutive validation failures since the last successful
     * validation. Reset to 0 on `validation_status = 'ok'`. Drives the
     * staleness alert: at 3 or more consecutive failures it emits a
     * structured warning and, optionally, a GitHub issue.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (table) => [
    primaryKey({ name: "feed_state_pkey", columns: [table.region, table.name] }),
    check("feed_state_status_check", sql`${table.status} IN ('active','stale','failed','unknown')`),
    check(
      "feed_state_validation_status_check",
      sql`${table.validationStatus} IN ('ok','warning','error')`,
    ),
  ],
);

/**
 * The Overture places release each region last imported. `links_pending`
 * means the release is live but its link rebuild did not complete.
 */
export const overtureRelease = dataManager.table(
  "overture_release",
  {
    region: text("region").notNull(),
    release: text("release").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
    /** "imported" | "links_pending" */
    status: text("status").notNull(),
  },
  (table) => [
    primaryKey({ name: "overture_release_pkey", columns: [table.region] }),
    check("overture_release_status_check", sql`${table.status} IN ('imported','links_pending')`),
  ],
);

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
    uniqueIndex("offline_package_jobs_request_key_live_key")
      .on(table.requestKey)
      .where(sql`${table.status} IN ('preparing', 'ready-to-download')`),
    index("offline_package_jobs_status_created_at_idx").on(table.status, table.createdAt),
    index("offline_package_jobs_package_id_idx").on(table.packageId),
  ],
);

/** Many opaque principals may independently own/account for one deduplicated physical job. */
export const offlinePackageJobOwners = dataManager.table(
  "offline_package_job_owners",
  {
    jobId: uuid("job_id").notNull(),
    principal: text("principal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "offline_package_job_owners_pkey",
      columns: [table.jobId, table.principal],
    }),
    foreignKey({
      name: "offline_package_job_owners_job_id_fkey",
      columns: [table.jobId],
      foreignColumns: [offlinePackageJobs.id],
    }).onDelete("cascade"),
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
    primaryKey({
      name: "offline_package_artifact_references_pkey",
      columns: [table.principal, table.packageId],
    }),
    index("offline_package_artifact_references_package_id_idx").on(table.packageId),
    index("offline_package_artifact_references_principal_retained_at_idx").on(
      table.principal,
      table.retainedAt,
    ),
  ],
);
