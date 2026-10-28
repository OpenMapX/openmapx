import type { AuthPolicySettings, AuthPolicySnapshot } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const authPolicyState = pgTable(
  "auth_policy_state",
  {
    id: integer("id").primaryKey(),
    activationVersion: integer("activation_version").notNull(),
    settings: jsonb("settings").$type<AuthPolicySettings>().notNull(),
    revision: text("revision").notNull(),
    activatedBy: text("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("auth_policy_singleton", sql`${t.id}=1 AND ${t.activationVersion}=1`)],
);
export const authPolicyApplication = pgTable("auth_policy_application", {
  key: text("key").primaryKey(),
  actorId: text("actor_id").notNull(),
  intentDigest: text("intent_digest").notNull(),
  snapshot: jsonb("snapshot").$type<AuthPolicySnapshot>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
