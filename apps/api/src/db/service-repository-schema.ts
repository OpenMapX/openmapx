import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const serviceRepository = pgTable("service_repository", {
  hash: text("hash").primaryKey(),
  url: text("url").notNull().unique(),
  displayName: text("display_name"),
  lastFetchedAt: timestamp("last_fetched_at"),
  lastSha: text("last_sha"),
  autoUpdate: boolean("auto_update").notNull().default(false),
  // Pinned git tag/branch. When set, refresh re-clones this ref instead of
  // tracking the default branch HEAD — service parity with sha256-pinned
  // integration artifacts.
  pinnedRef: text("pinned_ref"),
  // Extension id that owns this repo (installed as part of a bundle). Manual
  // refresh/remove of an extension-managed repo is refused — the extension's
  // install/update/uninstall flow manages it instead.
  managedByExtension: text("managed_by_extension"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ServiceRepositoryRow = typeof serviceRepository.$inferSelect;
