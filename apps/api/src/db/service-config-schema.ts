import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-service operator config. Mirrors the integration_config pattern: one row
 * per service-id, JSONB blob whose shape is the service manifest's
 * `configSchema` (rendered in the admin panel via rjsf).
 */
export const serviceConfig = pgTable("service_config", {
  serviceId: text("service_id").primaryKey(),
  config: jsonb("config").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type ServiceConfigRow = typeof serviceConfig.$inferSelect;
