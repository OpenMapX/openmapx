import {
  ATTENTION_CLEARANCES,
  ATTENTION_SEVERITIES,
  type AttentionAction,
  type AttentionClearance,
  type AttentionSeverity,
} from "@openmapx/core/api-contracts";
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
import { oneOf } from "./closed-value-check";

/**
 * Something an administrator should look at, raised by the platform and kept
 * until resolved. Resolving an item deletes its row: the audit log and job
 * history already record what happened, and who acknowledged it is only in the
 * audit log.
 */
export const attentionItem = pgTable(
  "attention_item",
  {
    key: text("key").primaryKey(),
    severity: text("severity").$type<AttentionSeverity>().notNull(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    action: jsonb("action").$type<AttentionAction>(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    clearance: text("clearance").$type<AttentionClearance>().notNull().default("condition"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    // Bounded by the input contract, not by a CHECK.
    occurrenceRef: text("occurrence_ref"),
  },
  (table) => [
    check("attention_item_severity_check", oneOf(table.severity, ATTENTION_SEVERITIES)),
    check("attention_item_clearance_check", oneOf(table.clearance, ATTENTION_CLEARANCES)),
  ],
);

/** Consecutive good and bad readings of one attention key, kept across API restarts. */
export const attentionObservation = pgTable("attention_observation", {
  key: text("key").primaryKey(),
  badCount: integer("bad_count").notNull().default(0),
  goodCount: integer("good_count").notNull().default(0),
  since: timestamp("since", { withTimezone: true }).notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ATTENTION_NOTIFICATION_CHANNELS = ["email", "webhook"] as const;
export const ATTENTION_NOTIFICATION_STATUSES = [
  "pending",
  "sending",
  "sent",
  "retryable",
  "failed",
  "canceled",
] as const;

/**
 * One notification of one occurrence of an attention item on one channel.
 * Recipients are resolved when a batch is sent, so no account is stored, and
 * `attention_key` has no foreign key because the item may be deleted while
 * its row is canceled. `occurrence` holds the item's raise time and severity,
 * so a re-raise or an escalation is a new occurrence.
 */
export const attentionNotification = pgTable(
  "attention_notification",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    attentionKey: text("attention_key").notNull(),
    occurrence: text("occurrence").notNull(),
    channel: text("channel").$type<(typeof ATTENTION_NOTIFICATION_CHANNELS)[number]>().notNull(),
    severity: text("severity").$type<"warning" | "critical">().notNull(),
    status: text("status")
      .$type<(typeof ATTENTION_NOTIFICATION_STATUSES)[number]>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "attention_notification_channel_check",
      oneOf(table.channel, ATTENTION_NOTIFICATION_CHANNELS),
    ),
    check(
      "attention_notification_severity_check",
      oneOf(table.severity, ["warning", "critical"] as const),
    ),
    check(
      "attention_notification_status_check",
      oneOf(table.status, ATTENTION_NOTIFICATION_STATUSES),
    ),
    uniqueIndex("attention_notification_attention_key_occurrence_channel_key").on(
      table.attentionKey,
      table.occurrence,
      table.channel,
    ),
    // The dispatcher's claim path.
    index("attention_notification_status_due_at_idx").on(table.status, table.dueAt),
  ],
);

export type AttentionItemRow = typeof attentionItem.$inferSelect;
export type AttentionObservationRow = typeof attentionObservation.$inferSelect;
export type AttentionNotificationRow = typeof attentionNotification.$inferSelect;
