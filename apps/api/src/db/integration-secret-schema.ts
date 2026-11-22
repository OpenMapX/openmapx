import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const integrationSecret = pgTable(
  "integration_secret",
  {
    id: text("id").primaryKey(),
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
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    unique("integrationSecret_integrationId_key_unq").on(table.integrationId, table.key),
    index("integration_secret_updated_by_idx").on(table.updatedBy),
  ],
);
