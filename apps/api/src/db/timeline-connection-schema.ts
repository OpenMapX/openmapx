import type { TimelineConnectionMode, TimelineConnectionStatus } from "@openmapx/core";
import { index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const personalTimelineConnection = pgTable(
  "personal_timeline_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
    index("personalTimelineConnection_userId_idx").on(table.userId),
    unique("personalTimelineConnection_userId_unq").on(table.userId),
  ],
);

export type PersonalTimelineConnectionRow = typeof personalTimelineConnection.$inferSelect;
