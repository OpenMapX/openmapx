import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/** Admission is arbitrated by this index; it must stay in step with the system routes. */
export const ACTIVE_SYSTEM_MAINTENANCE_INDEX = "adminJob_one_active_system_maintenance_uq";

/** The statuses of a job the runner still owns. */
export const ACTIVE_ADMIN_JOB_STATUSES = ["queued", "running", "cancel_pending"] as const;
export type ActiveAdminJobStatus = (typeof ACTIVE_ADMIN_JOB_STATUSES)[number];

/**
 * `status IN (…)` with the statuses written as SQL literals. The partial
 * indexes below are restricted to active jobs; PostgreSQL uses them only when
 * it can prove a query's statuses fall inside that predicate, which bound
 * parameters cannot show once a prepared statement runs with a generic plan.
 */
export function adminJobStatusIn(
  column: AnyPgColumn,
  statuses: readonly ActiveAdminJobStatus[],
): SQL {
  const literals = statuses
    .filter((status) => ACTIVE_ADMIN_JOB_STATUSES.includes(status))
    .map((status) => `'${status}'`);
  if (literals.length !== statuses.length || literals.length === 0)
    throw Error("Unknown active admin job status");
  return sql`${column} IN (${sql.raw(literals.join(", "))})`;
}

export const adminJob = pgTable(
  "admin_job",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload"),
    result: jsonb("result"),
    /** The runner's own state: claim, observation lease, cancel request and agent operations. */
    protocol: jsonb("protocol").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    progress: integer("progress"),
    /** Lines written to the job's log; the next line's `seq`. */
    logEvents: integer("log_events").notNull().default(0),
    /** UTF-8 bytes of those lines. */
    logBytes: integer("log_bytes").notNull().default(0),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "admin_job_status_check",
      sql`${table.status} in ('queued','running','cancel_pending','success','failed','canceled')`,
    ),
    // The runner looks up active jobs by type; finished jobs are listed by time.
    index("admin_job_type_idx")
      .on(table.type)
      .where(adminJobStatusIn(table.status, ACTIVE_ADMIN_JOB_STATUSES)),
    index("admin_job_created_by_idx").on(table.createdBy),
    index("adminJob_createdAt_idx").on(table.createdAt),
    // The update-check, update-apply and diagnostics requests share one host
    // writer slot. The constant key makes the whole active set a single entry.
    uniqueIndex(ACTIVE_SYSTEM_MAINTENANCE_INDEX)
      .on(sql`(true)`)
      .where(
        sql`${table.type} IN ('system.update', 'system.diagnostics') AND ${adminJobStatusIn(table.status, ACTIVE_ADMIN_JOB_STATUSES)}`,
      ),
  ],
);

export const adminJobLog = pgTable(
  "admin_job_log",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => adminJob.id, { onDelete: "cascade" }),
    /** Position in the job's log, allocated from `admin_job.log_events`. */
    seq: integer("seq").notNull(),
    stream: text("stream").notNull().default("stdout"),
    line: text("line").notNull(),
    /** The agent event a relayed line came from, so a replayed event is written once. */
    sourceEventId: text("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "admin_job_log_pkey", columns: [table.jobId, table.seq] }),
    check("admin_job_log_stream_check", sql`${table.stream} in ('stdout','stderr')`),
    uniqueIndex("admin_job_log_job_id_source_event_id_key")
      .on(table.jobId, table.sourceEventId)
      .where(sql`${table.sourceEventId} IS NOT NULL`),
  ],
);
