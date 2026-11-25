import {
  ACTIVE_JOB_STATUSES,
  type ActiveJobStatus,
  ADMIN_JOB_TYPES,
  type AdminJobType,
  JOB_STATUSES,
  type JobStatus,
  SYSTEM_MAINTENANCE_JOB_TYPES,
} from "@openmapx/core/jobs";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
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
export const ACTIVE_SYSTEM_MAINTENANCE_INDEX = "admin_job_active_system_maintenance_key";

/** `column IN (…)` over registry values written as SQL literals. */
function literalsIn(column: AnyPgColumn, values: readonly string[]): SQL {
  if (values.length === 0 || values.some((value) => !/^[a-z][a-z_.]*$/.test(value)))
    throw Error("Unsafe value literal");
  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

/**
 * `status IN (…)` with the statuses written as SQL literals. The partial
 * indexes below are restricted to active jobs; PostgreSQL uses them only when
 * it can prove a query's statuses fall inside that predicate, which bound
 * parameters cannot show once a prepared statement runs with a generic plan.
 */
export function adminJobStatusIn(column: AnyPgColumn, statuses: readonly ActiveJobStatus[]): SQL {
  if (!statuses.every((status) => ACTIVE_JOB_STATUSES.includes(status)))
    throw Error("Unknown active admin job status");
  return literalsIn(column, statuses);
}

export const adminJob = pgTable(
  "admin_job",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    type: text("type").$type<AdminJobType>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
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
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "admin_job_created_by_user_id_fkey",
      columns: [table.createdByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check("admin_job_status_check", literalsIn(table.status, JOB_STATUSES)),
    check("admin_job_type_check", literalsIn(table.type, ADMIN_JOB_TYPES)),
    // The runner looks up active jobs by type; finished jobs are listed by time.
    index("admin_job_type_idx")
      .on(table.type)
      .where(adminJobStatusIn(table.status, ACTIVE_JOB_STATUSES)),
    index("admin_job_created_by_user_id_idx").on(table.createdByUserId),
    index("admin_job_created_at_idx").on(table.createdAt),
    // The update-check, update-apply and diagnostics requests share one host
    // writer slot. The constant key makes the whole active set a single entry.
    uniqueIndex(ACTIVE_SYSTEM_MAINTENANCE_INDEX)
      .on(sql`(true)`)
      .where(
        sql`${literalsIn(table.type, SYSTEM_MAINTENANCE_JOB_TYPES)} AND ${adminJobStatusIn(table.status, ACTIVE_JOB_STATUSES)}`,
      ),
  ],
);

export const adminJobLog = pgTable(
  "admin_job_log",
  {
    jobId: uuid("job_id").notNull(),
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
    foreignKey({
      name: "admin_job_log_job_id_fkey",
      columns: [table.jobId],
      foreignColumns: [adminJob.id],
    }).onDelete("cascade"),
    check("admin_job_log_stream_check", sql`${table.stream} in ('stdout','stderr')`),
    uniqueIndex("admin_job_log_job_id_source_event_id_key")
      .on(table.jobId, table.sourceEventId)
      .where(sql`${table.sourceEventId} IS NOT NULL`),
  ],
);
