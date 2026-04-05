import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    targetId: text("target_id"),
    targetType: text("target_type"),
    action: text("action").notNull(),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_actorId_idx").on(table.actorId),
    index("audit_action_idx").on(table.action),
    index("audit_createdAt_idx").on(table.createdAt),
  ],
);
