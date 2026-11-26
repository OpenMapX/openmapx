import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const integrationSecret = pgTable(
  "integration_secret",
  {
    integrationId: text("integration_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedByUserId: text("updated_by_user_id"),
    // The owning extension, kept without a foreign key as on integration_config.
    ownerExtensionId: text("owner_extension_id"),
  },
  (table) => [
    primaryKey({ name: "integration_secret_pkey", columns: [table.integrationId, table.key] }),
    foreignKey({
      name: "integration_secret_updated_by_user_id_fkey",
      columns: [table.updatedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("integration_secret_updated_by_user_id_idx").on(table.updatedByUserId),
  ],
);
