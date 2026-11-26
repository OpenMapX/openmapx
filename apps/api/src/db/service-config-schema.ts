import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-service operator config. Mirrors the integration_config pattern: one row
 * per service-id, JSONB blob whose shape is the service manifest's
 * `configSchema` (rendered in the admin panel via rjsf).
 */
export const serviceConfig = pgTable(
  "service_config",
  {
    serviceId: text("service_id").primaryKey(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    // The extension that owns the row; null for a built-in or operator-owned
    // one. No foreign key: removing an extension with its data kept leaves the
    // row for that extension alone to re-attach.
    ownerExtensionId: text("owner_extension_id"),
    schemaVersion: integer("schema_version").notNull().default(1),
  },
  (table) => [check("service_config_schema_version_check", sql`${table.schemaVersion} > 0`)],
);

export type ServiceConfigRow = typeof serviceConfig.$inferSelect;
