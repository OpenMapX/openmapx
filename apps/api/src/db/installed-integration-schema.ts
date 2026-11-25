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
    installedByUserId: text("installed_by_user_id"),
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
      name: "installed_integration_installed_by_user_id_fkey",
      columns: [table.installedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("installed_integration_installed_by_user_id_idx").on(table.installedByUserId),
    check(
      "installed_integration_source_type_check",
      sql`${table.sourceType} in ('registry','artifact','source','uploaded-artifact')`,
    ),
  ],
);
