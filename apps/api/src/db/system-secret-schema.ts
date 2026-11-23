import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * The values of secret system settings (SMTP password, provider API keys),
 * AES-256-GCM encrypted with the API's secrets key. Non-secret settings stay
 * in `system_settings`.
 */
export const systemSecret = pgTable(
  "system_secret",
  {
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({ name: "system_secret_pkey", columns: [table.key] }),
    foreignKey({
      name: "system_secret_updated_by_fkey",
      columns: [table.updatedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("system_secret_updated_by_idx").on(table.updatedBy),
  ],
);
