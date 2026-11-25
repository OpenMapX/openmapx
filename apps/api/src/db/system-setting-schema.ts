import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { STORED_SETTING_KEYS } from "../services/setting-defs";
import { user } from "./auth-schema";

/** A SQL list of string literals; the keys are registry constants, never input. */
export const settingKeyList = (keys: readonly string[]) =>
  sql.raw(keys.map((key) => `'${key.replaceAll("'", "''")}'`).join(","));

export const systemSetting = pgTable(
  "system_setting",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => [
    foreignKey({
      name: "system_setting_updated_by_user_id_fkey",
      columns: [table.updatedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("system_setting_updated_by_user_id_idx").on(table.updatedByUserId),
    check(
      "system_setting_key_check",
      sql`${table.key} in (${settingKeyList(STORED_SETTING_KEYS)})`,
    ),
  ],
);
