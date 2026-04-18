import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const serviceRepository = pgTable("service_repository", {
  hash: text("hash").primaryKey(),
  url: text("url").notNull().unique(),
  displayName: text("display_name"),
  lastFetchedAt: timestamp("last_fetched_at"),
  lastSha: text("last_sha"),
  autoUpdate: boolean("auto_update").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ServiceRepositoryRow = typeof serviceRepository.$inferSelect;
