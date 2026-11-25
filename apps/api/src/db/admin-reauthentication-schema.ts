import { ADMIN_REAUTH_PURPOSES, type AdminReauthPurpose } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { oneOf } from "./closed-value-check";
import type { SessionAuthMethod } from "./privacy-auth-schema";

type ReauthenticationStatus = "pending" | "completed" | "consumed" | "superseded" | "expired";
export const adminActionReauthentication = pgTable(
  "admin_action_reauthentication",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorUserId: text("actor_user_id").notNull(),
    startingSessionId: text("starting_session_id").notNull(),
    purpose: text("purpose").$type<AdminReauthPurpose>().notNull(),
    targetId: text("target_id").notNull(),
    intentFingerprint: text("intent_fingerprint"),
    nonceDigest: text("nonce_digest").notNull(),
    requestKey: text("request_key"),
    authPolicyRevision: text("auth_policy_revision"),
    status: text("status").$type<ReauthenticationStatus>().default("pending").notNull(),
    completedSessionId: text("completed_session_id"),
    completedMethod: text("completed_method").$type<SessionAuthMethod>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "admin_action_reauthentication_actor_user_id_fkey",
      columns: [t.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    check(
      "admin_action_reauthentication_status_check",
      sql`${t.status} in ('pending','completed','consumed','superseded','expired')`,
    ),
    check("admin_action_reauthentication_purpose_check", oneOf(t.purpose, ADMIN_REAUTH_PURPOSES)),
    check(
      "admin_action_reauthentication_completed_method_check",
      sql`${t.completedMethod} in ('password','password_totp','password_recovery','passkey','federated')`,
    ),
    index("admin_action_reauthentication_actor_user_id_expires_at_idx").on(
      t.actorUserId,
      t.expiresAt,
    ),
    index("admin_action_reauthentication_expires_at_idx").on(t.expiresAt),
    uniqueIndex("admin_action_reauthentication_actor_user_id_request_key_key").on(
      t.actorUserId,
      t.requestKey,
    ),
  ],
);
