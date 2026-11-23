import type { StandaloneIntegrationProvenance } from "@openmapx/core/ops";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// An installed Extension *bundle* — the parent record that ties together the
// per-component substrate (installed_integration rows + service_repository rows)
// so a bundle installs/updates/removes as one version-coupled unit. A degenerate
// single-component extension is the common case (a lone integration or service).
export const installedExtension = pgTable(
  "installed_extension",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Catalog/source URL the bundle was resolved from (null for raw-URL installs).
    sourceUrl: text("source_url"),
    // Effective trust tier resolved at install: built-in | verified | community.
    sourceTrust: text("source_trust").notNull().default("community"),
    installationKind: text("installation_kind", { enum: ["catalog", "standalone"] })
      .notNull()
      .default("catalog"),
    provenance: jsonb("provenance").$type<StandaloneIntegrationProvenance>(),
    lastOperationId: text("last_operation_id"),
    installedVersion: text("installed_version").notNull(),
    // Snapshot of the resolved extension.json we installed (what to remove/update).
    manifest: jsonb("manifest"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    installedBy: text("installed_by"),
  },
  (table) => [
    foreignKey({
      name: "installed_extension_installed_by_fkey",
      columns: [table.installedBy],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("installed_extension_installed_by_idx").on(table.installedBy),
    check(
      "installed_extension_source_trust_check",
      sql`${table.sourceTrust} in ('built-in','verified','community')`,
    ),
    check(
      "installed_extension_installation_kind_check",
      sql`${table.installationKind} in ('catalog','standalone')`,
    ),
    check(
      "installed_extension_standalone_provenance_check",
      sql`${table.installationKind} <> 'standalone' or coalesce((${table.sourceTrust} = 'community' and ${table.id} ~ '^local-[0-9a-f-]{36}$' and jsonb_typeof(${table.provenance}) = 'object' and ${table.provenance}->>'kind' in ('artifact','source','uploaded-artifact') and ${table.provenance}->>'contentDigest' ~ '^[a-f0-9]{64}$'),false)`,
    ),
  ],
);

// One row per component an extension installed, linking to the per-component
// substrate (installed_integration.id for integrations, the service id for
// services). Lets uninstall remove exactly what the extension placed.
export const installedExtensionComponent = pgTable(
  "installed_extension_component",
  {
    extensionId: text("extension_id").notNull(),
    kind: text("kind").notNull(), // "integration" | "service"
    componentId: text("component_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "installed_extension_component_pkey",
      columns: [table.extensionId, table.kind, table.componentId],
    }),
    foreignKey({
      name: "installed_extension_component_extension_id_fkey",
      columns: [table.extensionId],
      foreignColumns: [installedExtension.id],
    }).onDelete("cascade"),
    check(
      "installed_extension_component_kind_check",
      sql`${table.kind} in ('integration','service')`,
    ),
    // One installed component belongs to exactly one extension. Without this a
    // second extension could claim a component another extension installed and
    // then remove or reconfigure it.
    uniqueIndex("installed_extension_component_kind_component_id_key").on(
      table.kind,
      table.componentId,
    ),
  ],
);

export type InstalledExtensionRow = typeof installedExtension.$inferSelect;
export type InstalledExtensionComponentRow = typeof installedExtensionComponent.$inferSelect;
