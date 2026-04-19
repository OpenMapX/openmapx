import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Per-service operator config. Mirrors the integration_config pattern: one row
 * per service-id, JSONB blob whose shape is the service manifest's
 * `configSchema` (rendered in the admin panel via rjsf).
 */
export const serviceConfig = pgTable(
  "service_config",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("serviceConfig_serviceId_idx").on(table.serviceId),
    unique("serviceConfig_serviceId_unq").on(table.serviceId),
  ],
);

export type ServiceConfigRow = typeof serviceConfig.$inferSelect;
