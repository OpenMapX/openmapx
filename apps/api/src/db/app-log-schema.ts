import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const appLog = pgTable(
  "app_logs",
  {
    id: serial("id").primaryKey(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    msg: text("msg").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("app_logs_level_source_idx").on(t.level, t.source, t.createdAt)],
);
