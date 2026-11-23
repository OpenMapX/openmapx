import { foreignKey, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const integrationSecret = pgTable(
  "integration_secret",
  {
    integrationId: text("integration_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({ name: "integration_secret_pkey", columns: [table.integrationId, table.key] }),
    foreignKey({
      name: "integration_secret_updated_by_fkey",
      columns: [table.updatedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("integration_secret_updated_by_idx").on(table.updatedBy),
  ],
);
