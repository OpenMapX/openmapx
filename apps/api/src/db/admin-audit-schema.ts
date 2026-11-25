import {
  AUDIT_ACTION_NAMES,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditTargetType,
} from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { oneOf } from "./closed-value-check";

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorUserId: text("actor_user_id"),
    targetId: text("target_id"),
    targetType: text("target_type").$type<AuditTargetType>(),
    /** The target account when `target_type` is `user`, kept beside the
     * polymorphic target so deleting the account clears it. */
    targetUserId: text("target_user_id"),
    action: text("action").$type<AuditAction>().notNull(),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "admin_audit_log_actor_user_id_fkey",
      columns: [table.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "admin_audit_log_target_user_id_fkey",
      columns: [table.targetUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check("admin_audit_log_action_check", oneOf(table.action, AUDIT_ACTION_NAMES)),
    check("admin_audit_log_target_type_check", oneOf(table.targetType, AUDIT_TARGET_TYPES)),
    index("admin_audit_log_actor_user_id_idx").on(table.actorUserId),
    index("admin_audit_log_action_idx").on(table.action),
    index("admin_audit_log_created_at_idx").on(table.createdAt),
    index("admin_audit_log_target_user_id_idx").on(table.targetUserId),
    // The audit filter and the erasure trigger select by target.
    index("admin_audit_log_target_type_target_id_idx").on(table.targetType, table.targetId),
  ],
);
