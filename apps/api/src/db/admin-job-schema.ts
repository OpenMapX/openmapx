import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/** Admission is arbitrated by this index; it must stay in step with the system routes. */
export const ACTIVE_SYSTEM_MAINTENANCE_INDEX = "adminJob_one_active_system_maintenance_uq";

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
      .where(sql`${table.status} IN ('queued', 'running', 'cancel_pending')`),
    index("admin_job_created_by_idx").on(table.createdBy),
    index("adminJob_createdAt_idx").on(table.createdAt),
    // The update-check, update-apply and diagnostics requests share one host
    // writer slot. The constant key makes the whole active set a single entry.
    uniqueIndex(ACTIVE_SYSTEM_MAINTENANCE_INDEX)
      .on(sql`(true)`)
      .where(
        sql`${table.type} IN ('system.update', 'system.diagnostics') AND ${table.status} IN ('queued', 'running', 'cancel_pending')`,
      ),
  ],
);

export const adminJobLog = pgTable(
  "admin_job_log",
  {
    id: text("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => adminJob.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stream: text("stream").notNull().default("stdout"),
    line: text("line").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("admin_job_log_stream_check", sql`${table.stream} in ('stdout','stderr')`),
    index("adminJobLog_jobId_idx").on(table.jobId),
  ],
);
