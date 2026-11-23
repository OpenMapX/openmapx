import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: text("actor_id"),
    targetId: text("target_id"),
    targetType: text("target_type"),
    /** The target account when `target_type` is `user`, kept beside the
     * polymorphic target so deleting the account clears it. */
    targetUserId: text("target_user_id"),
    action: text("action").notNull(),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "admin_audit_log_actor_id_fkey",
      columns: [table.actorId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "admin_audit_log_target_user_id_fkey",
      columns: [table.targetUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("admin_audit_log_actor_id_idx").on(table.actorId),
    index("admin_audit_log_action_idx").on(table.action),
    index("admin_audit_log_created_at_idx").on(table.createdAt),
    index("admin_audit_log_target_user_id_idx").on(table.targetUserId),
    // The audit filter and the erasure trigger select by target.
    index("admin_audit_log_target_type_target_id_idx").on(table.targetType, table.targetId),
  ],
);
