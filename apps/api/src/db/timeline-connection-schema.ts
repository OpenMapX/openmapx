import type { TimelineConnectionMode, TimelineConnectionStatus } from "@openmapx/core";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const personalTimelineConnection = pgTable(
  "personal_timeline_connection",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id").notNull(),
    mode: text("mode").$type<TimelineConnectionMode>().notNull(),
    publicOrigin: text("public_origin").notNull(),
    displayName: text("display_name").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    encryptionIv: text("encryption_iv").notNull(),
    encryptionTag: text("encryption_tag").notNull(),
    upstreamUserId: text("upstream_user_id"),
    upstreamEmail: text("upstream_email"),
    upstreamTimeZone: text("upstream_time_zone").notNull(),
    distanceUnit: text("distance_unit"),
    status: text("status").$type<TimelineConnectionStatus>().default("connected").notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "personal_timeline_connection_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    unique("personal_timeline_connection_user_id_key").on(table.userId),
    check("personal_timeline_connection_mode_check", sql`${table.mode} in ('external','managed')`),
    check(
      "personal_timeline_connection_status_check",
      sql`${table.status} in ('connected','degraded','invalid')`,
    ),
  ],
);

export type PersonalTimelineConnectionRow = typeof personalTimelineConnection.$inferSelect;
