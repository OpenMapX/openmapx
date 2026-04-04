import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: text("updated_by"),
});
