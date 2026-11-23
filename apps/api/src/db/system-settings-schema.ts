import { foreignKey, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      name: "system_settings_updated_by_fkey",
      columns: [table.updatedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("system_settings_updated_by_idx").on(table.updatedBy),
  ],
);
