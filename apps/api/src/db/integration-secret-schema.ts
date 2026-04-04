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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    index("integrationSecret_integrationId_idx").on(table.integrationId),
    unique("integrationSecret_integrationId_key_unq").on(table.integrationId, table.key),
  ],
);
