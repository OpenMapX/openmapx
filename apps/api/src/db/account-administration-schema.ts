import type { AuthPolicySettings, AuthPolicySnapshot } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export const authPolicyState = pgTable(
  "auth_policy_state",
  {
    id: integer("id").primaryKey(),
    settings: jsonb("settings").$type<AuthPolicySettings>().notNull(),
    revision: text("revision").notNull(),
    activatedByUserId: text("activated_by_user_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "auth_policy_state_activated_by_user_id_fkey",
      columns: [t.activatedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check("auth_policy_state_singleton_check", sql`${t.id}=1`),
    index("auth_policy_state_activated_by_user_id_idx").on(t.activatedByUserId),
  ],
);
export const authPolicyApplication = pgTable(
  "auth_policy_application",
  {
    key: text("key").primaryKey(),
    actorUserId: text("actor_user_id"),
    intentDigest: text("intent_digest").notNull(),
    snapshot: jsonb("snapshot").$type<AuthPolicySnapshot>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "auth_policy_application_actor_user_id_fkey",
      columns: [t.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("auth_policy_application_actor_user_id_idx").on(t.actorUserId),
    index("auth_policy_application_created_at_idx").on(t.createdAt),
  ],
);

export const accountAdminGuard = pgTable(
  "account_admin_guard",
  { id: integer("id").primaryKey(), activeCount: integer("active_count").notNull() },
  (t) => [
    check("account_admin_guard_singleton_check", sql`${t.id}=1`),
    check("account_admin_guard_active_count_check", sql`${t.activeCount}>=0`),
  ],
);
