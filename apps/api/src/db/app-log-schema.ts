import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appLog = pgTable(
  "app_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    msg: text("msg").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("app_logs_level_source_idx").on(t.level, t.source, t.createdAt),
    index("app_logs_created_at_idx").on(t.createdAt),
  ],
);
