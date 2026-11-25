import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { SECRET_SETTING_KEYS } from "../services/setting-defs";
import { user } from "./auth-schema";
import { settingKeyList } from "./system-setting-schema";

/**
 * The values of secret system settings (SMTP password, provider API keys),
 * AES-256-GCM encrypted with the API's secrets key and bound to the row's key.
 * Non-secret settings stay in `system_setting`.
 */
export const systemSecret = pgTable(
  "system_secret",
  {
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => [
    primaryKey({ name: "system_secret_pkey", columns: [table.key] }),
    foreignKey({
      name: "system_secret_updated_by_user_id_fkey",
      columns: [table.updatedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("system_secret_updated_by_user_id_idx").on(table.updatedByUserId),
    check("system_secret_key_check", sql`${table.key} in (${settingKeyList(SECRET_SETTING_KEYS)})`),
  ],
);
