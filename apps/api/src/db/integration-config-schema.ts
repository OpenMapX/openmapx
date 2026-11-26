import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Per-integration operator config: one row per integration id. */
export const integrationConfig = pgTable(
  "integration_config",
  {
    integrationId: text("integration_id").primaryKey(),
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
  (table) => [check("integration_config_schema_version_check", sql`${table.schemaVersion} > 0`)],
);
