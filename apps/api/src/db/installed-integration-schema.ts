import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const installedIntegration = pgTable(
  "installed_integration",
  {
    id: text("id").primaryKey(),
    repository: text("repository").notNull(),
    installedVersion: text("installed_version").notNull(),
    sourceType: text("source_type").notNull().default("registry"), // registry | artifact
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    installedBy: text("installed_by").references(() => user.id, { onDelete: "set null" }),
    // Extension id that owns this integration (installed as part of a bundle).
    // The standalone integration store skips update/remove of managed rows.
    managedByExtension: text("managed_by_extension"),
  },
  (table) => [index("installedIntegration_sourceType_idx").on(table.sourceType)],
);
