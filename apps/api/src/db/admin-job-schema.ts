import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const adminJob = pgTable(
  "admin_job",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"), // queued|running|success|failed|canceled
    payload: jsonb("payload"),
    result: jsonb("result"),
    error: text("error"),
    progress: integer("progress"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("adminJob_status_idx").on(table.status),
    index("adminJob_type_idx").on(table.type),
    index("adminJob_createdAt_idx").on(table.createdAt),
  ],
);

export const adminJobLog = pgTable(
  "admin_job_log",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => adminJob.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stream: text("stream").notNull().default("stdout"), // stdout|stderr
    line: text("line").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("adminJobLog_jobId_idx").on(table.jobId)],
);
