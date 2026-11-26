import { INTEGRATION_TASK_RUN_STATUSES, type IntegrationTaskRunStatus } from "@openmapx/core/jobs";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { oneOf } from "./closed-value-check";

// None of these tables references installed_integration: a built-in
// integration may also schedule tasks, own tables and register a handler, and
// the rows outlive a disabled extension or one removed with its data kept.

/** A migration file of an installed integration that ran in its `ext_<id>` schema. */
export const extensionMigration = pgTable(
  "extension_migration",
  {
    integrationId: text("integration_id").notNull(),
    name: text("name").notNull(),
    sha256: text("sha256").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "extension_migration_pkey", columns: [table.integrationId, table.name] }),
    // The archive's migration name grammar, so a name one accepts the other does.
    check(
      "extension_migration_name_check",
      sql`${table.name} ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*\\.sql$'`,
    ),
    check("extension_migration_sha256_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** One run of a task an integration registered with `ctx.schedule`. */
export const integrationTaskRun = pgTable(
  "integration_task_run",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    integrationId: text("integration_id").notNull(),
    taskName: text("task_name").notNull(),
    status: text("status").$type<IntegrationTaskRunStatus>().notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    check("integration_task_run_status_check", oneOf(table.status, INTEGRATION_TASK_RUN_STATUSES)),
    // A change away from `running` sets `finished_at` in the same statement.
    check(
      "integration_task_run_finished_at_check",
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    // One run of a task at a time.
    uniqueIndex("integration_task_run_running_key")
      .on(table.integrationId, table.taskName)
      .where(sql`${table.status} = 'running'`),
    index("integration_task_run_started_at_idx").on(table.startedAt),
  ],
);

/** An account erasure an integration's handler has not carried out yet. */
export const subjectErasurePending = pgTable(
  "subject_erasure_pending",
  {
    integrationId: text("integration_id").notNull(),
    // No foreign key: the erasure trigger writes the row as the account is deleted.
    subjectUserId: text("subject_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({
      name: "subject_erasure_pending_pkey",
      columns: [table.integrationId, table.subjectUserId],
    }),
    check("subject_erasure_pending_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

/** An integration whose backend registered a personal-data handler. */
export const integrationSubjectHandler = pgTable("integration_subject_handler", {
  integrationId: text("integration_id").primaryKey(),
});

export type ExtensionMigrationRow = typeof extensionMigration.$inferSelect;
export type IntegrationTaskRunRow = typeof integrationTaskRun.$inferSelect;
export type SubjectErasurePendingRow = typeof subjectErasurePending.$inferSelect;
export type IntegrationSubjectHandlerRow = typeof integrationSubjectHandler.$inferSelect;
