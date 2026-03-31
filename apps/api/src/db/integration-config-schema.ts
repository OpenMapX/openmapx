import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const integrationConfig = pgTable(
  "integration_config",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("integrationConfig_integrationId_idx").on(table.integrationId),
    unique("integrationConfig_integrationId_unq").on(table.integrationId),
  ],
);
