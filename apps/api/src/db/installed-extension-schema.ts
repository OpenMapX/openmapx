import {
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
    installedVersion: text("installed_version").notNull(),
    // Snapshot of the resolved extension.json we installed (what to remove/update).
    manifest: jsonb("manifest"),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    installedBy: text("installed_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [index("installedExtension_sourceTrust_idx").on(table.sourceTrust)],
);

// One row per component an extension installed, linking to the per-component
// substrate (installed_integration.id for integrations, the service id for
// services). Lets uninstall remove exactly what the extension placed.
export const installedExtensionComponent = pgTable(
  "installed_extension_component",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => installedExtension.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "integration" | "service"
    componentId: text("component_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.extensionId, table.kind, table.componentId] }),
    index("installedExtensionComponent_componentId_idx").on(table.componentId),
    // One installed component belongs to exactly one extension. Without this a
    // second extension could claim a component another extension installed and
    // then remove or reconfigure it.
    uniqueIndex("installedExtensionComponent_kind_componentId_key").on(
      table.kind,
      table.componentId,
    ),
  ],
);

export type InstalledExtensionRow = typeof installedExtension.$inferSelect;
export type InstalledExtensionComponentRow = typeof installedExtensionComponent.$inferSelect;
