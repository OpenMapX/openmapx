import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appLog = pgTable(
  "app_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("app_log_created_at_idx").on(t.createdAt)],
);
