import { jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const integrationConfig = pgTable(
  "integration_config",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [unique("integrationConfig_integrationId_unq").on(table.integrationId)],
);
