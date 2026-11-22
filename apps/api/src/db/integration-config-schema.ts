import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Per-integration operator config: one row per integration id. */
export const integrationConfig = pgTable("integration_config", {
  integrationId: text("integration_id").primaryKey(),
  config: jsonb("config").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
