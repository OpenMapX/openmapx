import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Community service repositories installed by extensions. The operations agent
 * owns the checkouts in its community store and records which extension owns
 * each one; this table records the exact commit and agent transaction.
 */
export const serviceRepository = pgTable("service_repository", {
  // First 16 hex digits of the SHA-256 of the canonical URL; the checkout's
  // directory name on the host.
  hash: text("hash").primaryKey(),
  url: text("url").notNull().unique("service_repository_url_key"),
  lastSha: text("last_sha").notNull(),
  // Tag, branch or commit the extension manifest requested.
  pinnedRef: text("pinned_ref"),
  // The agent transaction that installed `lastSha`. Writing it in the same
  // database transaction as the extension record makes the install
  // authoritative; startup recovery commits a pending agent transaction only
  // when this matches it.
  lastTransactionId: text("last_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ServiceRepositoryRow = typeof serviceRepository.$inferSelect;
