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
  },
  (table) => [index("installedIntegration_sourceType_idx").on(table.sourceType)],
);
