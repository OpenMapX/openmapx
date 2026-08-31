import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * A revocable public share link for a saved list or a route.
 *
 * The raw token (returned once at mint/rotate) is never stored — only its
 * SHA-256. Revocation is a hard DELETE: a missing row is indistinguishable
 * from a never-existing one, and there is nothing to re-enable because the
 * token cannot be shown again.
 */
export const shareLink = pgTable(
  "share_link",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** SHA-256 of the raw token, base64url. Never the token itself. */
    tokenHash: text("token_hash").notNull().unique(),
    targetType: text("target_type").notNull(), // "list" | "route"
    /**
     * saved_list.id for list shares (both modes — owner-side grouping only;
     * snapshot resolution never reads it); null for routes. Deliberately no
     * FK: a deleted list makes a live share resolve 404 while a snapshot
     * share keeps serving its frozen payload.
     */
    targetId: text("target_id"),
    mode: text("mode").notNull(), // "live" | "snapshot"
    /** Owner-facing label captured at mint (list name / "A → B"). */
    label: text("label").notNull(),
    /** Frozen public payload for snapshot shares. */
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [index("shareLink_userId_idx").on(table.userId)],
);

export const shareLinkRelations = relations(shareLink, ({ one }) => ({
  user: one(user, { fields: [shareLink.userId], references: [user.id] }),
}));
