import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const installedIntegration = pgTable(
  "installed_integration",
  {
    id: text("id").primaryKey(),
    repository: text("repository"),
    installedVersion: text("installed_version").notNull(),
    // `registry` for catalog installs; a standalone install records its provenance kind.
    sourceType: text("source_type").notNull().default("registry"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    installedBy: text("installed_by"),
    // The owning extension, if any, is the installed_extension_component row
    // of kind "integration" for this id.
    // The operations agent's install transaction this row records. Writing it
    // commits the install; recovery commits a pending agent transaction only
    // when it matches. Null for rows written before the agent installed
    // integrations.
    lastTransactionId: text("last_transaction_id"),
  },
  (table) => [
    foreignKey({
      name: "installed_integration_installed_by_fkey",
      columns: [table.installedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("installed_integration_installed_by_idx").on(table.installedBy),
    check(
      "installed_integration_source_type_check",
      sql`${table.sourceType} in ('registry','artifact','source','uploaded-artifact')`,
    ),
  ],
);
